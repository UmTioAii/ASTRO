import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, ConfigError } from "../src/config";
import { Auditor, type AuditEvent } from "../src/audit";
import { Ledger } from "../src/ledger";
import {
  assertAgentQuota,
  assertProjectBudget,
  costByAgent,
  formatCostByAgent,
  sendAuditWebhook,
  TeamQuotaError,
} from "../src/team";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { ProviderError } from "../src/provider/types";

const baseConfig = {
  providers: { openai: { kind: "openai-compat" as const, baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("config team (F7-5)", () => {
  test("seção team completa aceita", () => {
    const cfg = validateConfig({
      ...structuredClone(baseConfig),
      team: {
        projectBudgetUsd: 10,
        agentQuotas: { coder: { dailyTokens: 1000, monthlyCostUsd: 2 } },
        auditWebhook: "http://hooks.local/astro",
      },
    });
    expect(cfg.team!.projectBudgetUsd).toBe(10);
    expect(cfg.team!.agentQuotas!.coder!.dailyTokens).toBe(1000);
    expect(cfg.team!.auditWebhook).toBe("http://hooks.local/astro");
  });

  test("quota de agent sem campos → ConfigError", () => {
    expect(() =>
      validateConfig({ ...structuredClone(baseConfig), team: { agentQuotas: { coder: {} } } }),
    ).toThrow(ConfigError);
  });

  test("budget negativo → ConfigError", () => {
    expect(() =>
      validateConfig({ ...structuredClone(baseConfig), team: { projectBudgetUsd: -1 } }),
    ).toThrow(ConfigError);
  });
});

describe("assertProjectBudget (F7-5)", () => {
  function ledgerWithCost(costUsd: number): Ledger {
    const dir = mkdtempSync(join(tmpdir(), "astro-team-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    // 1 token in com inputPerM = cost*1e6 → costUsd
    ledger.record(
      { run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0 },
      { inputPerM: costUsd * 1_000_000, outputPerM: 0, fonte: "t", verificado: true },
    );
    return ledger;
  }

  test("abaixo do orçamento passa", () => {
    expect(() => assertProjectBudget(ledgerWithCost(5), 10)).not.toThrow();
  });

  test("no orçamento → TeamQuotaError com sugestão de config pull", () => {
    const err = capture(() => assertProjectBudget(ledgerWithCost(10), 10));
    expect(err).toBeInstanceOf(TeamQuotaError);
    expect(err.message).toContain("orçamento mensal");
    expect(err.message).toContain("config pull");  });
});

describe("assertAgentQuota (F7-5)", () => {
  function ledgerWithAgentUsage(agent: string, tokens: number): Ledger {
    const dir = mkdtempSync(join(tmpdir(), "astro-team-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"), { warn: () => {} });
    ledger.record(
      { run: "r", agent, provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: tokens, tokensOut: 0 },
      undefined,
    );
    return ledger;
  }

  test("agent dentro da quota passa; outro agent não conta", () => {
    const quotas = { coder: { dailyTokens: 100 } };
    expect(() => assertAgentQuota(ledgerWithAgentUsage("coder", 50), quotas, "coder")).not.toThrow();
    // 200 tokens de 'planner' não afetam a quota de 'coder'
    expect(() => assertAgentQuota(ledgerWithAgentUsage("planner", 200), quotas, "coder")).not.toThrow();
  });

  test("agent no limite → TeamQuotaError citando o agent", () => {
    const err = capture(() => assertAgentQuota(ledgerWithAgentUsage("coder", 100), { coder: { dailyTokens: 100 } }, "coder"));
    expect(err).toBeInstanceOf(TeamQuotaError);
    expect(err.message).toContain("coder");
    expect(err.message).toContain("quota do agent");
  });
});

describe("custo por agente com profile (F-30)", () => {
  test("costByAgent acumula do ledger com agent + profile; tabela do CLI", () => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "astro-f30-")), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    ledger.record({ run: "r1", agent: "planner", profile: "premium", provider: "openai", model: "gpt-4o", credentialRef: "K", quotaDomain: "d", tokensIn: 1000, tokensOut: 500 }, price);
    ledger.record({ run: "r1", agent: "planner", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 100, tokensOut: 50 }, price);
    ledger.record({ run: "r1", agent: "coder", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 200, tokensOut: 100 }, price);

    const costs = costByAgent(ledger);
    expect(costs).toHaveLength(3);
    expect(costs.find((c) => c.profile === "premium")).toMatchObject({ agent: "planner", profile: "premium", costUsd: 0.0015 });
    expect(costs.find((c) => c.agent === "planner" && c.profile === undefined)!.costUsd).toBeCloseTo(0.00015, 12);
    const sum = costs.reduce((acc, c) => acc + c.costUsd, 0);
    expect(sum).toBeCloseTo(ledger.total().costUsd, 12); // D-10: leitura do ledger, sem segundo contador

    const table = formatCostByAgent(ledger);
    expect(table).toContain("planner");
    expect(table).toContain("premium");
    expect(table).toContain("gpt-4o");
    expect(table).toContain("US$");
    const empty = formatCostByAgent(new Ledger(join(mkdtempSync(join(tmpdir(), "astro-f30-")), "vazio.jsonl")));
    expect(empty).toContain("sem entradas"); // ledger vazio: mensagem clara
  });
});

describe("sendAuditWebhook (F7-5)", () => {
  const event: AuditEvent = {
    seq: 1, ts: new Date().toISOString(), run: "r1", agent: "a",
    tipo: "tool.call", payload: { name: "grep" },
  };

  test("POST chega com o evento; 3 tentativas quando falha", async () => {
    let calls = 0;
    const ok = await sendAuditWebhook(
      "http://hooks.local/e",
      event,
      {
        fetchLike: (async () => {
          calls++;
          return calls < 3 ? new Response("boom", { status: 500 }) : Response.json({});
        }) as unknown as typeof fetch,
        backoffMs: 1,
      },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("todas as tentativas falham → false sem lançar", async () => {
    let calls = 0;
    const ok = await sendAuditWebhook("http://dead", event, {
      fetchLike: (async () => {
        calls++;
        throw new Error("rede fora");
      }) as unknown as typeof fetch,
      retries: 3,
      backoffMs: 1,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(3);
  });

  test("webhook recebe eventos de um Auditor real", async () => {
    const received: AuditEvent[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req): Promise<Response> {
        received.push(JSON.parse(await req.text()) as AuditEvent);
        return Response.json({});
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-team-"));
      const audit = new Auditor(join(dir, "audit.jsonl"), {
        onEvent: (e) => void sendAuditWebhook(`http://127.0.0.1:${server.port}/e`, e, { backoffMs: 1 }),
      });
      audit.append({ run: "r1", agent: "coder", tipo: "tool.call", payload: { name: "grep" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]!.tipo).toBe("tool.call");
    } finally {
      server.stop(true);
    }
  });
});

describe("sessão com team limits (F7-5)", () => {
  const model: ModelEntry = {
    provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  };
  const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
    content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
  });

  test("budget do projeto excedido bloqueia o provider antes da chamada", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-team-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"), { warn: () => {} });
    // custo do mês já no orçamento (1 token in = US$ 10)
    ledger.record(
      { run: "old", agent: "x", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0 },
      { inputPerM: 10_000_000, outputPerM: 0, fonte: "t", verificado: true },
    );

    let calls = 0;
    const provider: Provider = { complete: async () => { calls++; return resp({ content: "x" }); } };
    const opts: SessionOptions = {
      run: "r1", agent: "coder", credentialRef: "K", quotaDomain: "d",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [], allow: [], audit }),
      ledger, audit, maxSteps: 3,
      teamLimits: { projectBudgetUsd: 10 },
    };

    const err = await runSession(opts, "tarefa").then(() => null, (e) => e as TeamQuotaError);
    expect(err!).toBeInstanceOf(TeamQuotaError);
    expect(err!.message).toContain("config pull");
    expect(calls).toBe(0);
  });

  test("TeamQuotaError é ProviderError hard_quota", () => {
    const err = new TeamQuotaError("x");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.errClass).toBe("hard_quota");
  });
});

function capture(fn: () => void): TeamQuotaError {
  try {
    fn();
    throw new Error("esperava TeamQuotaError");
  } catch (error) {
    if (error instanceof TeamQuotaError) return error;
    throw error;
  }
}