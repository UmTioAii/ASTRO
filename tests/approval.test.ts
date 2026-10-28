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

  test("runTask sem TTY: pending, audit e interrupted; fallback não executa", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-approval-"));
    let fallbackCalls = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/bad")) return new Response("x", { status: 400 });
      fallbackCalls++;
      return Response.json({ choices: [{ message: { content: "b" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/bad/v1`, credentialRef: "KEY_A", fallback: ["b"] },
          b: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/ok/v1`, credentialRef: "KEY_B" },
        },
        models: [
          { provider: "a", id: "m1", tags: ["writing-code"], context: 8192,
            price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false }, capabilities: { streaming: true } },
          { provider: "b", id: "m1", tags: ["writing-code"], context: 8192,
            price: { inputPerM: 3, outputPerM: 3, fonte: "t", verificado: false }, capabilities: { jsonMode: true } },
        ],
        agent: { model: "a/m1", maxSteps: 1, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      await expect(runTask({ configPath, task: "x", cwd, env: { KEY_A: "a", KEY_B: "b" } })).rejects.toThrow(/troca não aprovada \(pending\)/);
      expect(fallbackCalls).toBe(0); // identidade original mantida

      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
      const requested = audit.find((e) => e.tipo === "swap.requested");
      expect(requested?.payload).toMatchObject({
        from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m1" }, reason: "invalid_request",
        costDeltaUsd: 2, capabilityDelta: ["+jsonMode", "-streaming"],
      });
      expect(audit.some((e) => e.tipo === "swap.pending")).toBe(true);
      const interrupted = new Ledger(join(cwd, ".astro", "ledger.jsonl")).readStates().find((s) => s.state === "interrupted");
      expect(interrupted?.reason).toBe("swap_denied");
    } finally {
      server.stop(true);
    }
  });

  test("runTask com aprovação explícita negada: audit denied e sem fallback", async () => {    const cwd = mkdtempSync(join(tmpdir(), "astro-approval-"));
    let fallbackCalls = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/bad")) return new Response("x", { status: 400 });
      fallbackCalls++;
      return Response.json({ choices: [{ message: { content: "b" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/bad/v1`, credentialRef: "KEY_A", fallback: ["b"] },
          b: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/ok/v1`, credentialRef: "KEY_B" },
        },
        models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "a/m1", maxSteps: 1, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      await expect(runTask({ configPath, task: "x", cwd, env: { KEY_A: "a", KEY_B: "b" }, approveSwap: () => false }))
        .rejects.toThrow(/troca não aprovada \(denied\)/);
      expect(fallbackCalls).toBe(0);
      expect(new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll().some((e) => e.tipo === "swap.denied")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("runTask com aprovação explícita: recebe deltas, audita approved e executa", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-approval-"));
    let fallbackCalls = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/bad")) return new Response("x", { status: 400 });
      fallbackCalls++;
      return Response.json({ choices: [{ message: { content: "b" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/bad/v1`, credentialRef: "KEY_A", fallback: ["b"] },
          b: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/ok/v1`, credentialRef: "KEY_B" },
        },
        models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "a/m1", maxSteps: 1, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      let seen: SwapRequest | undefined;
      const report = await runTask({ configPath, task: "x", cwd, env: { KEY_A: "a", KEY_B: "b" },
        approveSwap: (request) => { seen = request; return true; } });
      expect(report.final).toBe("b");
      expect(fallbackCalls).toBe(1);
      expect(seen).toMatchObject({ from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m1" } });
      expect(seen?.costDeltaUsd).toBeNull(); // sem preço curado
      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
      expect(audit.some((e) => e.tipo === "swap.approved")).toBe(true);
      expect(audit.some((e) => e.tipo === "swap.denied" || e.tipo === "swap.pending")).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
