import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { BudgetExceededError, enforceBudget } from "../src/budget";
import type { BudgetConfig } from "../src/config";
import { Ledger } from "../src/ledger";

function ledgerWith(costUsd: number | null): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "astro-budget-enf-"));
  const path = join(dir, "ledger.jsonl");
  appendFileSync(path, `${JSON.stringify({
    schemaVersion: 1, ts: new Date().toISOString(), run: "r1", agent: "a", provider: "p", model: "m",
    credentialRef: "K", quotaDomain: "default", tokensIn: 1, tokensOut: 1, costUsd, kind: "usage", seq: 1,
  })}\n`);
  return new Ledger(path);
}

const budget = (extra: Partial<BudgetConfig> = {}): BudgetConfig =>
  ({ scope: "day", limitUsd: 1, warnAt: 0.8, onExceed: "ask", ...extra });

function base(ledger: Ledger, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "astro-budget-enf-audit-"));
  return {
    budget: budget(),
    ledger,
    run: "r1",
    agent: "coder",
    audit: new Auditor(join(dir, "audit.jsonl")),
    interactive: false,
    ...extra,
  };
}

describe("enforcement de budget (F-05, #132 parte 3)", () => {
  test("sem TTY: não bloqueia esperando input, grava non_interactive e para", async () => {
    const ledger = ledgerWith(2);
    const opts = base(ledger);
    await expect(enforceBudget(opts)).rejects.toBeInstanceOf(BudgetExceededError);
    const events = ledger.readAllEntries().filter((e) => e.kind === "budget");
    expect(events.some((e) => e.kind === "budget" && e.event === "non_interactive"
      && e.budget_exceeded_non_interactive === true)).toBe(true);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.exceeded")).toBe(true);
  });

  test("onExceed stop para sem perguntar e registra a escolha", async () => {
    const ledger = ledgerWith(2);
    const error = await enforceBudget(base(ledger, { budget: budget({ onExceed: "stop" }), interactive: true }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).reason).toBe("limit");
    expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "exceeded" && e.exceeded_choice === "stop")).toBe(true);
  });

  test("TTY: continue_same e lower_effort não param; a escolha é registrada", async () => {
    for (const choice of ["continue_same", "lower_effort"] as const) {
      const ledger = ledgerWith(2);
      const result = await enforceBudget(base(ledger, { interactive: true, decide: () => choice }));
      expect(result).toBe(choice);
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "exceeded" && e.exceeded_choice === choice)).toBe(true);
    }
    const ledger = ledgerWith(2);
    await expect(enforceBudget(base(ledger, { interactive: true, decide: () => "stop" })))
      .rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("hardCeilingUsd para mesmo com escolha continue e registra ceiling_hit", async () => {
    const ledger = ledgerWith(2);
    const opts = base(ledger, {
      interactive: true, decide: () => "continue_same",
      budget: budget({ limitUsd: 10, hardCeilingUsd: 1 }),
    });
    const error = await enforceBudget(opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).reason).toBe("ceiling");
    expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "ceiling_hit" && e.ceiling_hit === true)).toBe(true);
    expect(opts.audit.readAll().some((e) => e.tipo === "budget.ceiling_hit")).toBe(true);
  });

  test("use-as-you-go nunca para, mesmo acima do gasto", async () => {
    const ledger = ledgerWith(100);
    await expect(enforceBudget(base(ledger, { budget: budget({ scope: "use-as-you-go", limitUsd: null }) }))).resolves.toBe("continue_same");
  });
});

/** Run com provider que gasta `usage` por chamada e sempre pede tool call até o teto. */
async function runWithBudget(budgetCfg: Record<string, unknown>, usage = 1000) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-budget-enf-run-"));
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() {
    calls++;
    return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: `c${calls}`, type: "function",
      function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: usage, completion_tokens: 0 } });
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
      price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } }],
    agent: { model: "p/m", maxSteps: 4, tools: [] },
    budget: budgetCfg,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return { cwd, configPath, calls: () => calls, stop: () => server.stop(true) };
}

describe("corte de budget no run (F-05, #132 parte 3)", () => {
  test("não-interativo: para em ponto seguro sem esperar input", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 1 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } }))
        .rejects.toThrow(/budget esgotado/);
      expect(calls()).toBe(1);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readStates().some((s) => s.state === "interrupted")).toBe(true);
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "non_interactive")).toBe(true);
    } finally {
      stop();
    }
  });

  test("TTY com continue_same prossegue até o teto de passos", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 1 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" },
        onBudgetExceeded: () => "continue_same" })).rejects.toThrow(/excedeu 4 passos/);
      expect(calls()).toBe(4);
      expect(new Ledger(join(cwd, ".astro", "ledger.jsonl")).readAllEntries()
        .some((e) => e.kind === "budget" && e.event === "exceeded" && e.exceeded_choice === "continue_same")).toBe(true);
    } finally {
      stop();
    }
  });

  test("lower_effort reduz os passos restantes", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 1 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" },
        onBudgetExceeded: () => "lower_effort" })).rejects.toBeDefined();
      expect(calls()).toBe(2); // 4 passos, reduzidos à metade no step 2
    } finally {
      stop();
    }
  });

  test("hardCeilingUsd corta mesmo com continue_same", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 10, hardCeilingUsd: 1 });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => "continue_same" }))
        .rejects.toThrow(/budget esgotado/);
      expect(calls()).toBe(1);
      expect(new Ledger(join(cwd, ".astro", "ledger.jsonl")).readAllEntries()
        .some((e) => e.kind === "budget" && e.event === "ceiling_hit")).toBe(true);
    } finally {
      stop();
    }
  });
});
