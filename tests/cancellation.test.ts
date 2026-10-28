import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { CompletionCache, cachedProvider } from "../src/cache";
import { Ledger } from "../src/ledger";
import { FallbackProvider } from "../src/provider/fallback-provider";
import { refreshCodexTokens } from "../src/provider/codex-auth";
import { ProfileFallbackProvider } from "../src/provider/profile-fallback-provider";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runTask } from "../src/app";
import { runMultiAgentSession, runSession, type MultiAgentSessionOptions, type SessionOptions } from "../src/session";
import { handoffTool } from "../src/tools/handoff";
import { writeFileTool } from "../src/tools/write-file";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool } from "../src/tools/types";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `astro-${tag}-`));

/** Tool que cancela o run ao executar (aborta durante o passo). */
const cancelTool = (controller: AbortController): Tool => ({
  manifest: {
    name: "cancel", description: "aborta o run", parameters: { type: "object", properties: {} },
    risk: "low", permission: "test", timeoutMs: 1000, retryable: false, idempotent: false, sideEffects: "none",
  },
  async execute() {
    controller.abort(new Error("cancelado na tool"));
    return { output: "ok" };
  },
});

/** Sessão de teste: script de promessas por passo; abort propaga para o provider fake. */
function setup(script: (() => Promise<CompletionResponse>)[]) {
  const cwd = dir("cancel");
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  let i = 0;
  const provider: Provider = {
    complete: async (_req: CompletionRequest, signal?: AbortSignal) =>
      new Promise<CompletionResponse>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Abortado", "AbortError")));
        const fn = script[i++];
        if (!fn) return reject(new Error("script esgotado"));
        fn().then(resolve, reject);
      }),
  };
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "K", quotaDomain: "default", cwd,
    provider, model, executor: new ToolExecutor({ tools: [], allow: [], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { cwd, opts };
}

describe("cancelamento explícito (F-06, #127)", () => {
  test("AbortSignal interrompe a sessão e grava interrupted/cancelled", async () => {
    const { opts } = setup([() => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new DOMException("Abortado", "AbortError")), 500);
    })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    opts.signal = controller.signal;

    await expect(runSession(opts, "tarefa longa")).rejects.toBeDefined();
    const interrupted = opts.ledger.readStates().find((s) => s.state === "interrupted");
    expect(interrupted?.reason).toBe("cancelled");
  });

  test("runTask e2e: abort em voo, erro claro, audit cancelled e um único interrupted", async () => {
    const cwd = dir("cancel-app");
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return Response.json({});
      },
    });
    try {
      writeFileSync(join(cwd, "astro.config.json"), JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
        models: [{ provider: "mock", id: "m", tags: ["writing-code"], context: 8192 }],
        agent: { model: "mock/m", maxSteps: 3, tools: [] },
        paths: { ledger: "ledger.jsonl", audit: "audit.jsonl" },
      }));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      let caught: unknown;
      try {
        await runTask({ configPath: join(cwd, "astro.config.json"), task: "t", cwd, env: { TEST_KEY: "x" }, signal: controller.signal });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toContain("cancelado");
      const interrupted = new Ledger(join(cwd, "ledger.jsonl")).readStates().filter((s) => s.state === "interrupted");
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]!.reason).toBe("cancelled");
      const stopped = new Auditor(join(cwd, "audit.jsonl")).readAll().find((e) => e.tipo === "run.stopped");
      expect(stopped?.payload.reason).toBe("cancelled");
    } finally {
      server.stop(true);
    }
  });

  test("abort não é retry: FallbackProvider e ProfileFallbackProvider param na 1ª chamada", async () => {
    const run = async (make: (a: Provider, b: Provider) => Provider, req: CompletionRequest) => {
      const controller = new AbortController();
      let first = 0;
      let second = 0;
      const a: Provider = {
        complete: async () => {
          first++;
          controller.abort(new Error("cancelado pelo SDK"));
          throw new Error("cancelado pelo SDK");
        },
      };
      const b: Provider = { complete: async () => { second++; return resp({ content: "não deveria" }); } };
      await expect(make(a, b).complete(req, controller.signal)).rejects.toBeDefined();
      expect(first).toBe(1);
      expect(second).toBe(0);
    };
    const fallback = (a: Provider, b: Provider) => new FallbackProvider({
      providers: [{ name: "a", priority: 1, create: () => a }, { name: "b", priority: 2, create: () => b }],
      maxRetries: 2, retryBackoffMs: 0,
    });
    const profile = (a: Provider, b: Provider) => new ProfileFallbackProvider({
      base: b,
      profiles: [
        { name: "p1", model: "m1", provider: "a", fallback: ["p2"], create: () => a },
        { name: "p2", model: "m2", provider: "b", fallback: [], create: () => b },
      ],
    });
    await run(fallback, { model: "m", messages: [] });
    await run(profile, { model: "m1", messages: [], profile: "p1" });
  });

  test("reason customizada de abort vira cancelled", async () => {
    const { opts } = setup([() => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout do SDK")), 500);
    })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout do SDK")), 20);
    opts.signal = controller.signal;

    await expect(runSession(opts, "tarefa")).rejects.toBeDefined();
    expect(opts.ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("cancelled");
  });

  test("ponto seguro (I-16): abort antes das tools não escreve arquivo", async () => {
    const cwd = dir("cancel-tools");
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const controller = new AbortController();
    const provider: Provider = {
      complete: async () => {
        controller.abort(new Error("cancelado"));
        return resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "nao-deve-existir.txt", content: "x" }) }] });
      },
    };
    const opts: SessionOptions = {
      run: "r1", agent: "default", credentialRef: "K", quotaDomain: "default", cwd,
      provider, model, executor: new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit }),
      ledger, audit, maxSteps: 3, signal: controller.signal,
    };

    await expect(runSession(opts, "escreva")).rejects.toBeDefined();
    expect(existsSync(join(cwd, "nao-deve-existir.txt"))).toBe(false);
    expect(ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("cancelled");
  });

  test("step guard: abort em tool impede o próximo step (F-06)", async () => {
    const cwd = dir("cancel-step");
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const controller = new AbortController();
    let calls = 0;
    const provider: Provider = {
      complete: async () => {
        calls++;
        return resp({ toolCalls: [{ id: "c1", name: "cancel", arguments: "{}" }] });
      },
    };
    const opts: SessionOptions = {
      run: "r1", agent: "default", credentialRef: "K", quotaDomain: "default", cwd,
      provider, model, executor: new ToolExecutor({ tools: [cancelTool(controller)], allow: ["cancel"], audit }),
      ledger, audit, maxSteps: 5, signal: controller.signal,
    };

    await expect(runSession(opts, "cancele")).rejects.toBeDefined();
    expect(calls).toBe(1); // sem novo step após o cancelamento
    expect(ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("cancelled");
  });

  test("codex refresh: abort não chama o fetch e propaga o motivo", async () => {
    const tokens = { accessToken: "a", refreshToken: "r", accountId: "x", expiresAt: 0 };
    const pre = new AbortController();
    pre.abort(new Error("cancelado antes do refresh"));
    let fetched = 0;
    await expect(refreshCodexTokens(tokens, async () => { fetched++; return Response.json({}); }, pre.signal))
      .rejects.toThrow("cancelado antes do refresh");
    expect(fetched).toBe(0);

    const mid = new AbortController();
    const fetchFn = async () => {
      mid.abort(new Error("cancelado no refresh"));
      throw mid.signal.reason;
    };
    await expect(refreshCodexTokens(tokens, fetchFn, mid.signal)).rejects.toThrow("cancelado no refresh");
  });

  test("cache: abort não serve hit nem grava resposta", async () => {
    const cache = new CompletionCache(join(dir("cancel-cache"), "cache.db"));
    let hits = 0;
    let calls = 0;
    const inner: Provider = { complete: async () => { calls++; return resp({ content: "ok" }); } };
    const wrapped = cachedProvider(inner, { cache, ttlHours: 24, maxEntries: 10, onHit: () => { hits++; } });
    await wrapped.complete({ model: "m", messages: [{ role: "user", content: "oi" }] });

    const aborted = new AbortController();
    aborted.abort(new Error("cancelado"));
    await expect(wrapped.complete({ model: "m", messages: [{ role: "user", content: "oi" }] }, aborted.signal)).rejects.toBeDefined();
    expect(hits).toBe(0);

    const controller = new AbortController();
    const ignoring: Provider = {
      complete: async () => { controller.abort(new Error("cancelado")); return resp({ content: "não cachear" }); },
    };
    const wrapped2 = cachedProvider(ignoring, { cache, ttlHours: 24, maxEntries: 10 });
    await expect(wrapped2.complete({ model: "m", messages: [{ role: "user", content: "outro" }] }, controller.signal)).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(cache.count()).toBe(1);
  });

  test("multi-agent: abort no subagent não executa tools nem grava handoff.failed", async () => {
    const cwd = dir("cancel-multi");
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const controller = new AbortController();
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff", "write_file", "cancel"] },
    };
    const registry = {
      requireAgent(name: string): AgentEntry {
        const agent = agents[name];
        if (agent === undefined) throw new Error(`agent "${name}" não encontrado`);
        return agent;
      },
      getAgent: (name: string): AgentEntry | undefined => agents[name],
    };
    let calls = 0;
    const provider: Provider = {
      complete: async () => {
        calls++;
        if (calls === 1) {
          return resp({ toolCalls: [{ id: "h1", name: "handoff",
            arguments: JSON.stringify({ to: "coder", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }) }] });
        }
        // coder: a tool cancela o run; o próximo step não deve ser iniciado
        return resp({ toolCalls: [{ id: "c1", name: "cancel", arguments: "{}" }] });
      },
    };
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "K", quotaDomain: "default", cwd, provider, registry, baseModel: model,
      baseExecutor: new ToolExecutor({ tools: [handoffTool, writeFileTool, cancelTool(controller)], allow: ["handoff", "write_file", "cancel"], audit }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "planner", signal: controller.signal,
    };

    await expect(runMultiAgentSession(opts, "delegue")).rejects.toBeDefined();
    expect(calls).toBe(2); // sem novo step após o cancelamento no subagent
    expect(existsSync(join(cwd, "multi-nao-deve-existir.txt"))).toBe(false);
    const kinds = ledger.readAllEntries().map((e) => e.kind);
    expect(kinds).toContain("handoff.created");
    expect(kinds).toContain("handoff.received");
    expect(kinds).not.toContain("handoff.failed");
    expect(ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("cancelled");
  });
});
