import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { SwapDeniedError, swapDelta, type SwapRequest } from "../src/approval";
import { Ledger } from "../src/ledger";
import { FallbackProvider } from "../src/provider/fallback-provider";
import { ProfileFallbackProvider } from "../src/provider/profile-fallback-provider";
import type { CompletionResponse, Provider } from "../src/provider/types";

const resp = (content: string): CompletionResponse => ({ content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });

function fallback(approveSwap?: (r: SwapRequest) => boolean) {
  let first = 0;
  let second = 0;
  const a: Provider = { complete: async () => { first++; throw Object.assign(new Error("x"), { errClass: "invalid_request" }); } };
  const b: Provider = { complete: async () => { second++; return resp("b"); } };
  const provider = new FallbackProvider({
    providers: [{ name: "a", priority: 1, create: () => a }, { name: "b", priority: 2, create: () => b }],
    maxRetries: 0,
    ...(approveSwap === undefined ? {} : { approveSwap }),
  });
  return { provider, calls: () => ({ first, second }) };
}

/** Servidor a→b (a responde 400) + config em cwd temporário; conta chamadas ao fallback. */
function e2e(priced = false) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-approval-"));
  const state = { fallbackCalls: 0 };
  const server = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname.startsWith("/bad")) return new Response("x", { status: 400 });
    state.fallbackCalls++;
    return Response.json({ choices: [{ message: { content: "b" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const models = priced
    ? [
      { provider: "a", id: "m1", tags: ["writing-code"], context: 8192,
        price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false }, capabilities: { streaming: true } },
      { provider: "b", id: "m1", tags: ["writing-code"], context: 8192,
        price: { inputPerM: 3, outputPerM: 3, fonte: "t", verificado: false }, capabilities: { jsonMode: true } },
    ]
    : [{ provider: "a", id: "m1", tags: ["writing-code"], context: 8192 }];
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/bad/v1`, credentialRef: "KEY_A", fallback: ["b"] },
      b: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/ok/v1`, credentialRef: "KEY_B" },
    },
    models,
    agent: { model: "a/m1", maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const audit = () => new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
  return { cwd, configPath, state, server, audit, ledger: new Ledger(join(cwd, ".astro", "ledger.jsonl")), env: { KEY_A: "a", KEY_B: "b" } };
}

describe("gate de aprovação de troca (F-19, #129)", () => {
  test("swapDelta calcula custo e capacidades (D-16)", () => {
    const delta = swapDelta(
      { price: { inputPerM: 1 }, capabilities: { tools: true, streaming: true } },
      { price: { inputPerM: 3 }, capabilities: { tools: true, jsonMode: true } },
    );
    expect(delta.costDeltaUsd).toBe(2);
    expect(delta.capabilityDelta).toEqual(["+jsonMode", "-streaming"]);
    expect(swapDelta(undefined, undefined)).toEqual({ costDeltaUsd: null, capabilityDelta: [] });
  });
  test("FallbackProvider: troca negada não executa o próximo provider", async () => {
    const { provider, calls } = fallback(() => false);
    await expect(provider.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(SwapDeniedError);
    expect(calls()).toEqual({ first: 1, second: 0 });
  });
  test("FallbackProvider: troca aprovada executa o próximo provider", async () => {
    const { provider, calls } = fallback(() => true);
    expect((await provider.complete({ model: "m", messages: [] })).content).toBe("b");
    expect(calls()).toEqual({ first: 1, second: 1 });
  });
  test("ProfileFallbackProvider: troca negada para no profile atual", async () => {
    let second = 0;
    const a: Provider = { complete: async () => { throw Object.assign(new Error("x"), { errClass: "invalid_request" }); } };
    const b: Provider = { complete: async () => { second++; return resp("b"); } };
    const provider = new ProfileFallbackProvider({
      base: b,
      profiles: [
        { name: "p1", model: "m1", provider: "a", fallback: ["p2"], create: () => a },
        { name: "p2", model: "m2", provider: "b", fallback: [], create: () => b },
      ],
      approveSwap: () => false,
    });
    await expect(provider.complete({ model: "m1", messages: [], profile: "p1" })).rejects.toBeInstanceOf(SwapDeniedError);
    expect(second).toBe(0);
  });

  test("negação vinda do provider interno é terminal (não vira hop)", async () => {
    const denied = () => new SwapDeniedError(
      { run: "r1", from: { provider: "a" }, to: { provider: "b" }, reason: "x" }, "denied",
    );
    let fallbackCalls = 0;
    const fallbackProvider = new FallbackProvider({
      providers: [
        { name: "a", priority: 1, create: () => ({ complete: async () => { throw denied(); } }) },
        { name: "b", priority: 2, create: () => ({ complete: async () => { fallbackCalls++; return resp("b"); } }) },
      ],
      maxRetries: 0,
    });
    await expect(fallbackProvider.complete({ model: "m", messages: [] })).rejects.toBeInstanceOf(SwapDeniedError);
    expect(fallbackCalls).toBe(0);

    let profileCalls = 0;
    const profileProvider = new ProfileFallbackProvider({
      base: { complete: async () => { profileCalls++; return resp("base"); } },
      profiles: [
        { name: "p1", model: "m1", provider: "a", fallback: ["p2"], create: () => ({ complete: async () => { throw denied(); } }) },
        { name: "p2", model: "m2", provider: "b", fallback: [], create: () => ({ complete: async () => { profileCalls++; return resp("p2"); } }) },
      ],
      approveSwap: () => true,
    });
    await expect(profileProvider.complete({ model: "m1", messages: [], profile: "p1" })).rejects.toBeInstanceOf(SwapDeniedError);
    expect(profileCalls).toBe(0);
  });

  test("runTask sem TTY: pending, audit, interrupted e resume aprova depois", async () => {
    const { cwd, configPath, state, server, audit, ledger, env } = e2e(true);
    try {
      await expect(runTask({ configPath, task: "x", cwd, env })).rejects.toThrow(/troca não aprovada \(pending\)/);
      expect(state.fallbackCalls).toBe(0); // identidade original mantida
      const requested = audit().find((e) => e.tipo === "swap.requested");
      expect(requested?.payload).toMatchObject({
        from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m1" }, reason: "invalid_request",
        costDeltaUsd: 2, capabilityDelta: ["+jsonMode", "-streaming"],
      });
      expect(audit().some((e) => e.tipo === "swap.pending")).toBe(true);
      const interrupted = ledger.readStates().find((s) => s.state === "interrupted");
      expect(interrupted?.reason).toBe("swap_denied");

      // Checkpoint retomável (I-19): com aprovação explícita o run conclui no fallback
      const resumed = await runTask({ configPath, task: "x", cwd, env, resume: interrupted!.run, approveSwap: () => true });
      expect(resumed.final).toBe("b");
      expect(state.fallbackCalls).toBe(1);
      expect(audit().some((e) => e.tipo === "swap.approved")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
  test("runTask com aprovação explícita negada: audit denied e sem fallback", async () => {
    const { cwd, configPath, state, server, audit, env } = e2e();
    try {
      await expect(runTask({ configPath, task: "x", cwd, env, approveSwap: () => false }))
        .rejects.toThrow(/troca não aprovada \(denied\)/);
      expect(state.fallbackCalls).toBe(0);
      expect(audit().some((e) => e.tipo === "swap.denied")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
  test("runTask com aprovação explícita: recebe deltas, audita approved e executa", async () => {
    const { cwd, configPath, state, server, audit, env } = e2e();
    try {
      let seen: SwapRequest | undefined;
      const report = await runTask({ configPath, task: "x", cwd, env,
        approveSwap: (request) => { seen = request; return true; } });
      expect(report.final).toBe("b");
      expect(state.fallbackCalls).toBe(1);
      expect(seen).toMatchObject({ from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m1" } });
      expect(seen?.costDeltaUsd).toBeNull(); // sem preço curado
      expect(audit().some((e) => e.tipo === "swap.approved")).toBe(true);
      expect(audit().some((e) => e.tipo === "swap.denied" || e.tipo === "swap.pending")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("approver que lança vira denied auditado e para sem fallback (I-04)", async () => {
    const { cwd, configPath, state, server, audit, env } = e2e();
    try {
      await expect(runTask({ configPath, task: "x", cwd, env, approveSwap: () => { throw new Error("boom"); } }))
        .rejects.toThrow(/troca não aprovada \(denied\)/);
      expect(state.fallbackCalls).toBe(0);
      const denied = audit().find((e) => e.tipo === "swap.denied");
      expect(denied?.payload).toMatchObject({ error: "Error" });
    } finally {
      server.stop(true);
    }
  });
});
