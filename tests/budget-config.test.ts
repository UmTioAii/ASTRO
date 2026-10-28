import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { ConfigError, validateConfig } from "../src/config";
import type { ModelConfig } from "../src/config";

const valid = {
  providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "KEY" } },
  models: [{ provider: "openai", id: "m1", tags: ["writing-code"], context: 8192 }] as ModelConfig[],
  agent: { model: "openai/m1", maxSteps: 5, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const withBudget = (budget: unknown, extra: Record<string, unknown> = {}) =>
  validateConfig({ ...structuredClone(valid), budget, ...extra });

describe("budget config (F-05, #132 parte 1)", () => {
  test("aplica defaults: warnAt 0.8 e onExceed ask", () => {
    const cfg = withBudget({ scope: "day", limitUsd: 10 });
    expect(cfg.budget).toEqual({ scope: "day", limitUsd: 10, warnAt: 0.8, onExceed: "ask" });
  });

  test("preserva campos explícitos e hardCeilingUsd", () => {
    const cfg = withBudget({ scope: "project", limitUsd: 25, warnAt: 0.5, onExceed: "stop", hardCeilingUsd: 30 });
    expect(cfg.budget).toEqual({ scope: "project", limitUsd: 25, warnAt: 0.5, onExceed: "stop", hardCeilingUsd: 30 });
  });

  test("use-as-you-go exige limitUsd null e nunca inventa limite", () => {
    const cfg = withBudget({ scope: "use-as-you-go", limitUsd: null });
    expect(cfg.budget?.limitUsd).toBeNull();
  });

  test("cada campo é validado (non-discard)", () => {
    const cases: [unknown, RegExp][] = [
      [{ scope: "semana", limitUsd: 1 }, /budget\.scope/],
      [{ scope: "day" }, /budget\.limitUsd/],
      [{ scope: "day", limitUsd: null }, /não pode ser null/],
      [{ scope: "use-as-you-go", limitUsd: 1 }, /deve ser null/],
      [{ scope: "day", limitUsd: -1 }, /budget\.limitUsd/],
      [{ scope: "day", limitUsd: 1, warnAt: 0 }, /budget\.warnAt/],
      [{ scope: "day", limitUsd: 1, warnAt: 1 }, /budget\.warnAt/],
      [{ scope: "day", limitUsd: 1, onExceed: "explode" }, /budget\.onExceed/],
      [{ scope: "day", limitUsd: 1, hardCeilingUsd: -5 }, /budget\.hardCeilingUsd/],
    ];
    for (const [budget, error] of cases) {
      expect(() => withBudget(budget)).toThrow(error);
    }
    expect(() => withBudget({ scope: "day", limitUsd: 1 })).not.toThrow();
  });

  test("run.maxTurns aceita inteiro positivo ou unlimited", () => {
    expect(withBudget(undefined, { run: { maxTurns: 3 } }).run?.maxTurns).toBe(3);
    expect(withBudget({ scope: "project", limitUsd: 5 }, { run: { maxTurns: "unlimited" } }).run?.maxTurns)
      .toBe("unlimited");
  });

  test("run.maxTurns inválido → ConfigError", () => {
    for (const maxTurns of [0, -1, 1.5, "infinito"]) {
      expect(() => withBudget(undefined, { run: { maxTurns } })).toThrow(/run\.maxTurns/);
    }
  });

  test("unlimited sem limitUsd nem hardCeilingUsd → unlimited_without_ceiling", () => {
    expect(() => withBudget(undefined, { run: { maxTurns: "unlimited" } })).toThrow(ConfigError);
    expect(() => withBudget(undefined, { run: { maxTurns: "unlimited" } })).toThrow(/unlimited_without_ceiling/);
    expect(() => withBudget({ scope: "use-as-you-go", limitUsd: null }, { run: { maxTurns: "unlimited" } }))
      .toThrow(/unlimited_without_ceiling/);
  });

  test("unlimited é aceito com limitUsd ou hardCeilingUsd", () => {
    expect(() => withBudget({ scope: "day", limitUsd: 1 }, { run: { maxTurns: "unlimited" } })).not.toThrow();
    expect(() => withBudget({ scope: "day", limitUsd: 0 }, { run: { maxTurns: "unlimited" } })).not.toThrow();
    expect(() => withBudget({ scope: "use-as-you-go", limitUsd: null, hardCeilingUsd: 2 }, { run: { maxTurns: "unlimited" } }))
      .not.toThrow();
  });
});

describe("run.maxTurns no runtime (F-05, #132 parte 1)", () => {
  /** Sobe um provider que sempre pede tool call e devolve quantas chamadas houve. */
  async function callsFor(extra: Record<string, unknown>, agentMaxSteps = 5): Promise<{ calls: number; message: string }> {
    const cwd = mkdtempSync(join(tmpdir(), "astro-maxturns-"));
    let calls = 0;
    const server = Bun.serve({ port: 0, async fetch() {
      calls++;
      return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
        function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        ...structuredClone(valid),
        agent: { ...structuredClone(valid.agent), maxSteps: agentMaxSteps },
        providers: { openai: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        ...extra,
      }));
      const message = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })
        .then(() => "concluiu", (error: unknown) => (error instanceof Error ? error.message : String(error)));
      return { calls, message };
    } finally {
      server.stop(true);
    }
  }

  test("limita a sessão e conta 1 chamada (agent.maxSteps maior)", async () => {
    const { calls, message } = await callsFor({ run: { maxTurns: 1 } });
    expect(calls).toBe(1);
    expect(message).toMatch(/excedeu 1 passos/);
  });

  test("maxTurns maior que agent.maxSteps não eleva o limite", async () => {
    const { calls, message } = await callsFor({ run: { maxTurns: 50 } }, 2);
    expect(calls).toBe(2);
    expect(message).toMatch(/excedeu 2 passos/);
  });

  test("unlimited fica limitado ao agent.maxSteps até o corte físico (B10)", async () => {
    const { calls } = await callsFor({ run: { maxTurns: "unlimited" }, budget: { scope: "use-as-you-go", limitUsd: null, hardCeilingUsd: 1 } }, 3);
    expect(calls).toBe(3);
  });

  test("limita o total no multi-agent (menor que a soma dos agentes)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-maxturns-multi-"));
    let calls = 0;
    const server = Bun.serve({ port: 0, async fetch() {
      calls++;
      return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
        function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      const agents = {
        planner: { model: "openai/m1", maxSteps: 10, tools: [] },
        coder: { model: "openai/m1", maxSteps: 10, tools: [] },
      };
      writeFileSync(configPath, JSON.stringify({
        ...structuredClone(valid),
        providers: { openai: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        agents,
        run: { maxTurns: 2 },
      }));
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toThrow(/excedeu 2 passos/);
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
