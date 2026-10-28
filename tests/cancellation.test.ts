import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { CompletionCache, cachedProvider } from "../src/cache";
import { Ledger } from "../src/ledger";
import { FallbackProvider } from "../src/provider/fallback-provider";
import { ProfileFallbackProvider } from "../src/provider/profile-fallback-provider";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runTask } from "../src/app";
import { runMultiAgentSession, runSession, type MultiAgentSessionOptions, type SessionOptions } from "../src/session";
import { handoffTool } from "../src/tools/handoff";
import { writeFileTool } from "../src/tools/write-file";
import { ToolExecutor } from "../src/tools/executor";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};

const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

function makeProvider(script: (() => Promise<CompletionResponse>)[]) {
  let i = 0;
  return {
    complete: async (req: CompletionRequest, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException("Abortado", "AbortError");
      return new Promise<CompletionResponse>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Abortado", "AbortError")));
        const fn = script[i++];
        if (!fn) return reject(new Error("script esgotado"));
        const r = fn();
        if (r instanceof Promise) r.then(resolve).catch(reject);
        else resolve(r);
      });
    },
  };
}

function setup(script: (() => Promise<CompletionResponse>)[]) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-session-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const provider = makeProvider(script);
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
    cwd, provider, model, executor: new ToolExecutor({ tools: [], allow: [], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { cwd, opts, ledger };
}

describe("cancelamento explícito (F-06, #127)", () => {
  test("cancelamento via AbortSignal interrompe o run e registra estado interrupted", async () => {
    const { opts, ledger } = setup([
      () => new Promise<never>((_, reject) => {
        setTimeout(() => reject(new DOMException("Abortado", "AbortError")), 500);
      }),
    ]);

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);

    opts.signal = abortController.signal;

    try {
      await runSession(opts, "tarefa longa");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    }

    // Verifica estado no ledger - session.ts mapeia abort para "cancelled" (F-06)
    const states = opts.ledger.readStates();
    const interrupted = states.find((s) => s.state === "interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted!.reason).toBe("cancelled");
  });

  test("runTask com signal abortado durante a chamada: erro claro, audit cancelled e um único estado interrupted", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-cancel-app-"));
    // Servidor que aceita a conexão mas nunca responde: o abort interrompe a chamada em voo.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return Response.json({});
      },
    });
    try {
      writeFileSync(
        join(cwd, "astro.config.json"),
        JSON.stringify({
          providers: {
            mock: {
              kind: "openai-compat",
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              credentialRef: "TEST_KEY",
            },
          },
          models: [{ provider: "mock", id: "m", tags: ["writing-code"], context: 8192 }],
          agent: { model: "mock/m", maxSteps: 3, tools: [] },
          paths: { ledger: "ledger.jsonl", audit: "audit.jsonl" },
        }),
      );

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 50);

      let caught: unknown;
      try {
        await runTask({
          configPath: join(cwd, "astro.config.json"),
          task: "tarefa",
          cwd,
          env: { TEST_KEY: "test" },
          signal: abortController.signal,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("cancelado");

      // Um único estado interrupted, com reason cancelled (sem duplicação de camadas)
      const ledger = new Ledger(join(cwd, "ledger.jsonl"));
      const interruptedStates = ledger.readStates().filter((s) => s.state === "interrupted");
      expect(interruptedStates).toHaveLength(1);
      expect(interruptedStates[0]!.reason).toBe("cancelled");

      // Audit registra o stop por cancelamento
      const audit = new Auditor(join(cwd, "audit.jsonl"));
      const stopped = audit.readAll().find((e) => e.tipo === "run.stopped");
      expect(stopped).toBeDefined();
      expect(stopped!.payload.reason).toBe("cancelled");
    } finally {
      server.stop(true);
    }
  });

  test("abort não é retry: FallbackProvider para na primeira chamada e não tenta o próximo provider", async () => {
    const controller = new AbortController();
    let firstCalls = 0;
    let secondCalls = 0;
    const aborting: Provider = {
      complete: async (_req, signal) => {
        firstCalls++;
        controller.abort(new Error("cancelado pelo SDK")); // reason customizada
        throw signal?.reason ?? new DOMException("Abortado", "AbortError");
      },
    };
    const second: Provider = {
      complete: async () => {
        secondCalls++;
        return resp({ content: "não deveria executar" });
      },
    };
    const fallback = new FallbackProvider({
      providers: [
        { name: "first", priority: 1, create: () => aborting },
        { name: "second", priority: 2, create: () => second },
      ],
      maxRetries: 2,
      retryBackoffMs: 0,
    });

    await expect(fallback.complete({ model: "m", messages: [] }, controller.signal)).rejects.toBeDefined();
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  });

  test("abort não é retry: ProfileFallbackProvider para no profile atual e não aciona o fallback", async () => {
    const controller = new AbortController();
    let firstCalls = 0;
    let secondCalls = 0;
    const aborting: Provider = {
      complete: async (_req, signal) => {
        firstCalls++;
        controller.abort(new Error("cancelado pelo SDK"));
        throw signal?.reason ?? new DOMException("Abortado", "AbortError");
      },
    };
    const second: Provider = {
      complete: async () => {
        secondCalls++;
        return resp({ content: "não deveria executar" });
      },
    };
    const provider = new ProfileFallbackProvider({
      base: second,
      profiles: [
        { name: "p1", model: "m1", provider: "a", fallback: ["p2"], create: () => aborting },
        { name: "p2", model: "m2", provider: "b", fallback: [], create: () => second },
      ],
    });

    await expect(
      provider.complete({ model: "m1", messages: [], profile: "p1" }, controller.signal),
    ).rejects.toBeDefined();
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  });

  test("reason customizada de abort é tratada como cancelamento (cancelled)", async () => {
    const { opts } = setup([
      () => new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout do SDK")), 500);
      }),
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout do SDK")), 20);
    opts.signal = controller.signal;

    await expect(runSession(opts, "tarefa")).rejects.toBeDefined();

    const interrupted = opts.ledger.readStates().find((s) => s.state === "interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted!.reason).toBe("cancelled");
  });

  test("ponto seguro: abort antes das tools impede escrita de arquivo (I-16)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-cancel-tools-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const controller = new AbortController();

    // Provider responde com uma tool call, mas aborta o signal antes de resolver:
    // a sessão deve parar antes de executar a tool.
    const provider: Provider = {
      complete: async () => {
        controller.abort(new Error("cancelado"));
        return resp({
          toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "nao-deve-existir.txt", content: "x" }) }],
        });
      },
    };
    const opts: SessionOptions = {
      run: "r1", agent: "default", credentialRef: "K", quotaDomain: "default",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit }),
      ledger, audit, maxSteps: 3, signal: controller.signal,
    };

    await expect(runSession(opts, "escreva")).rejects.toBeDefined();
    expect(existsSync(join(cwd, "nao-deve-existir.txt"))).toBe(false);
    const interrupted = ledger.readStates().find((s) => s.state === "interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted!.reason).toBe("cancelled");
  });

  test("cache: signal abortado não serve hit nem grava resposta (F-06)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-cancel-cache-"));
    const cache = new CompletionCache(join(cwd, "cache.db"));
    let hits = 0;
    let calls = 0;
    const inner: Provider = {
      complete: async () => {
        calls++;
        return resp({ content: "resposta" });
      },
    };
    const wrapped = cachedProvider(inner, {
      cache, ttlHours: 24, maxEntries: 10, onHit: () => { hits++; },
    });

    // Popula o cache
    await wrapped.complete({ model: "m", messages: [{ role: "user", content: "oi" }] });
    expect(cache.count()).toBe(1);

    // Hit com signal já abortado não é servido
    const controller = new AbortController();
    controller.abort(new Error("cancelado"));
    await expect(
      wrapped.complete({ model: "m", messages: [{ role: "user", content: "oi" }] }, controller.signal),
    ).rejects.toBeDefined();
    expect(hits).toBe(0);

    // Provider que ignora o signal: resposta não é gravada
    const controller2 = new AbortController();
    const ignoring: Provider = {
      complete: async () => {
        calls++;
        controller2.abort(new Error("cancelado"));
        return resp({ content: "não deveria ser cacheada" });
      },
    };
    const wrapped2 = cachedProvider(ignoring, { cache, ttlHours: 24, maxEntries: 10 });
    await expect(
      wrapped2.complete({ model: "m", messages: [{ role: "user", content: "outro" }] }, controller2.signal),
    ).rejects.toBeDefined();
    expect(cache.count()).toBe(1); // só a entrada original
  });

  test("multi-agent: abort no subagent não executa tools nem grava handoff.failed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-cancel-multi-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const controller = new AbortController();

    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff", "write_file"] },
    };
    const registry = {
      requireAgent(name: string): AgentEntry {
        const agent = agents[name];
        if (agent === undefined) throw new Error(`agent "${name}" não encontrado`);
        return agent;
      },
      getAgent(name: string): AgentEntry | undefined {
        return agents[name];
      },
    };
    let calls = 0;
    const provider: Provider = {
      complete: async () => {
        calls++;
        if (calls === 1) {
          return resp({
            toolCalls: [{
              id: "h1",
              name: "handoff",
              arguments: JSON.stringify({ to: "coder", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }),
            }],
          });
        }
        // coder: cancela e ainda devolve uma tool; a sessão deve parar antes de executá-la
        controller.abort(new Error("cancelado no subagent"));
        return resp({
          toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "multi-nao-deve-existir.txt", content: "x" }) }],
        });
      },
    };
    const baseExecutor = new ToolExecutor({
      tools: [handoffTool, writeFileTool],
      allow: ["handoff", "write_file"],
      audit,
    });
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "K", quotaDomain: "default", cwd,
      provider, registry, baseModel: model, baseExecutor, ledger, audit,
      baseMaxSteps: 5, entryAgent: "planner", signal: controller.signal,
    };

    await expect(runMultiAgentSession(opts, "delegue")).rejects.toBeDefined();
    expect(existsSync(join(cwd, "multi-nao-deve-existir.txt"))).toBe(false);

    const kinds = ledger.readAllEntries().map((e) => e.kind);
    expect(kinds).toContain("handoff.created");
    expect(kinds).toContain("handoff.received");
    expect(kinds).not.toContain("handoff.failed");

    const interrupted = ledger.readStates().find((s) => s.state === "interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted!.reason).toBe("cancelled");
  });

  test("run normal (sem cancelamento) completa normalmente", async () => {
    const { opts, ledger } = setup([
      async () => resp({ content: "pronto" }),
    ]);

    const r = await runSession(opts, "diga oi");

    expect(r.steps).toBe(1);
    expect(r.final).toBe("pronto");

    // Verifica que NÃO há estado interrupted
    const states = opts.ledger.readStates();
    const interrupted = states.find((s) => s.state === "interrupted");
    expect(interrupted).toBeUndefined();

    const completed = states.find((s) => s.state === "completed");
    expect(completed).toBeDefined();
  });
});