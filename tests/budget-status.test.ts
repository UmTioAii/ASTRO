import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { budgetStatus, formatBudgetEstimate, restrictBudget } from "../src/budget";
import type { BudgetConfig } from "../src/config";
import { Ledger } from "../src/ledger";

const budget = (extra: Partial<BudgetConfig> = {}): BudgetConfig =>
  ({ scope: "day", limitUsd: 10, warnAt: 0.8, onExceed: "ask", ...extra });
const now = new Date("2026-10-28T12:00:00.000Z");

function ledgerWith(rows: Array<{ ts: string; costUsd: number | null }>): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "astro-budget-"));
  const path = join(dir, "ledger.jsonl");
  let seq = 0;
  for (const row of rows) {
    appendFileSync(path, `${JSON.stringify({
      schemaVersion: 1, ts: row.ts, run: "r1", agent: "a", provider: "p", model: "m",
      credentialRef: "K", quotaDomain: "default", tokensIn: 1, tokensOut: 1,
      costUsd: row.costUsd, kind: "usage", seq: ++seq,
    })}\n`);
  }
  return new Ledger(path);
}

const rows = [
  { ts: "2026-10-28T01:00:00.000Z", costUsd: 2 },
  { ts: "2026-10-27T23:00:00.000Z", costUsd: 5 },
  { ts: "2026-10-01T10:00:00.000Z", costUsd: 3 },
  { ts: "2026-09-30T10:00:00.000Z", costUsd: 7 },
];

describe("budget status (F-05, #132 parte 2)", () => {
  test("escopo day conta só o dia UTC", () => {
    const status = budgetStatus(budget(), ledgerWith(rows), now);
    expect(status.spentUsd).toBe(2);
    expect(status.ratio).toBe(0.2);
    expect(status.warning).toBe(false);
    expect(status.exhausted).toBe(false);
    expect(status.remainingUsd).toBe(8);
  });

  test("project usa a janela mensal do team; use-as-you-go conta tudo", () => {
    expect(budgetStatus(budget({ scope: "month" }), ledgerWith(rows), now).spentUsd).toBe(10);
    expect(budgetStatus(budget({ scope: "project" }), ledgerWith(rows), now).spentUsd).toBe(10);
    expect(budgetStatus(budget({ scope: "use-as-you-go", limitUsd: null }), ledgerWith(rows), now).spentUsd).toBe(17);
  });

  test("aviso em warnAt e esgotamento no limite", () => {
    const warn = budgetStatus(budget({ limitUsd: 2 }), ledgerWith(rows), now);
    expect(warn.warning).toBe(true);
    expect(warn.exhausted).toBe(true);
    const below = budgetStatus(budget({ limitUsd: 2, warnAt: 0.9 }), ledgerWith([{ ts: now.toISOString(), costUsd: 1 }]), now);
    expect(below.warning).toBe(false);
    // Fronteira exata: spent/limit === warnAt conta como aviso
    const edge = budgetStatus(budget({ limitUsd: 10, warnAt: 0.8 }), ledgerWith([{ ts: now.toISOString(), costUsd: 8 }]), now);
    expect(edge.warning).toBe(true);
    // Custo zero é zero real, não n/d
    const zero = budgetStatus(budget(), ledgerWith([{ ts: now.toISOString(), costUsd: 0 }]), now);
    expect(zero.spentUsd).toBe(0);
    expect(zero.estimate).toBe("US$ 0.000000");
    // Limit 0: qualquer run está no teto e avisa
    const noBudget = budgetStatus(budget({ limitUsd: 0 }), ledgerWith([{ ts: now.toISOString(), costUsd: 0 }]), now);
    expect(noBudget.exhausted).toBe(true);
    expect(noBudget.warning).toBe(true);
  });

  test("use-as-you-go nunca esgota nem inventa limite", () => {
    const status = budgetStatus(budget({ scope: "use-as-you-go", limitUsd: null }), ledgerWith(rows), now);
    expect(status.limitUsd).toBeNull();
    expect(status.exhausted).toBe(false);
    expect(status.warning).toBe(false);
    expect(status.remainingUsd).toBeNull();
    expect(status.estimate).toBe("US$ 17.000000");
  });

  test("preço ausente vira n/d, nunca zero (B6)", () => {
    const status = budgetStatus(budget(), ledgerWith([...rows, { ts: now.toISOString(), costUsd: null }]), now);
    expect(status.spentUsd).toBeNull();
    expect(status.ratio).toBeNull();
    expect(status.warning).toBe(false);
    expect(status.exhausted).toBe(false);
    expect(status.estimate).toBe("n/d");
    expect(formatBudgetEstimate(null)).toBe("n/d");
  });

  test("hardCeilingUsd é reportado separado do limite", () => {
    const status = budgetStatus(budget({ limitUsd: 10, hardCeilingUsd: 2 }), ledgerWith(rows), now);
    expect(status.ceilingHit).toBe(true);
    expect(status.exhausted).toBe(false);
  });

  test("escopo mais restritivo vence (budget x quota x team)", () => {
    expect(restrictBudget(budget({ limitUsd: 10 }), [4, 6]).limitUsd).toBe(4);
    expect(restrictBudget(budget({ limitUsd: 10 }), [undefined, 6]).limitUsd).toBe(6);
    expect(restrictBudget(budget({ scope: "use-as-you-go", limitUsd: null }), []).limitUsd).toBeNull();
  });
});

describe("aviso de budget no run (F-05, #132 parte 2)", () => {
  test("emite budget.warning uma vez e expõe o status no relatório", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-budget-run-"));
    let calls = 0;
    const server = Bun.serve({ port: 0, async fetch() {
      calls++;
      return calls === 1
        ? Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
          function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } })
        : Response.json({ choices: [{ message: { content: "fim" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
          price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } }],
        agent: { model: "p/m", maxSteps: 3, tools: [] },
        budget: { scope: "day", limitUsd: 1, warnAt: 0.8 },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(report.final).toBe("fim");
      expect(report.budget?.warning).toBe(true);
      expect(report.budget?.spentUsd).toBeGreaterThan(0);
      const warnings = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll().filter((e) => e.tipo === "budget.warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.payload).toMatchObject({ scope: "day", limitUsd: 1, warnAt: 0.8 });
    } finally {
      server.stop(true);
    }
  });

  test("avisa também quando o warnAt é cruzado no último step", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-budget-last-"));
    const server = Bun.serve({ port: 0, async fetch() {
      return Response.json({ choices: [{ message: { content: "fim" } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
          price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } }],
        agent: { model: "p/m", maxSteps: 1, tools: [] },
        budget: { scope: "day", limitUsd: 1, warnAt: 0.8 },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(report.budget?.warning).toBe(true);
      expect(new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll().filter((e) => e.tipo === "budget.warning")).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("sem preço no modelo, o relatório mostra n/d", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-budget-noprice-"));
    const server = Bun.serve({ port: 0, async fetch() {
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192 }],
        agent: { model: "p/m", maxSteps: 2, tools: [] },
        budget: { scope: "day", limitUsd: 1 },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(report.budget?.estimate).toBe("n/d");
      expect(report.budget?.spentUsd).toBeNull();
      expect(report.budget?.exhausted).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
