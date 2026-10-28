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
    const error = await enforceBudget(base(ledger, { budget: budget({ onExceed: "stop" }) }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).reason).toBe("limit");
    expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "exceeded" && e.exceeded_choice === "stop")).toBe(true);
  });

  test("hardCeilingUsd para mesmo com escolha continue e registra ceiling_hit", async () => {
    const ledger = ledgerWith(2);
    const opts = base(ledger, {
      decide: () => "continue_same",
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
async function runWithBudget(budgetCfg: Record<string, unknown>, usage = 1000, priced = true) {
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
      ...(priced ? { price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } } : {}) }],
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
      expect(ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("budget_exceeded");
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "non_interactive")).toBe(true);
      // Checkpoint retomável: resume re-aplica o enforcement e aceita a escolha
      const runId = ledger.readStates()[0]!.run;
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, resume: runId,
        onBudgetExceeded: () => "continue_same" })).rejects.toThrow(/excedeu 4 passos/);
      expect(calls()).toBeGreaterThan(1);
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "exceeded" && e.exceeded_choice === "continue_same")).toBe(true);
    } finally {
      stop();
    }
  });

  test("parada por budget com handoff recebido não invalida a retomada (I-19)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-budget-handoff-"));
    const server = Bun.serve({ port: 0, async fetch() {
      return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "h1", type: "function",
        function: { name: "handoff", arguments: JSON.stringify({ to: "coder", task: "t", objective: "o",
          decisions: [], constraints: [], next_steps: [] }) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 0 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
          price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } }],
        agent: { model: "p/m", maxSteps: 4, tools: ["handoff"] },
        agents: { planner: { model: "p/m", maxSteps: 2, tools: ["handoff"] }, coder: { model: "p/m", maxSteps: 2, tools: [] } },
        budget: { scope: "day", limitUsd: 1 },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toThrow(/budget esgotado/);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().some((e) => (e as { kind: string }).kind === "handoff.failed")).toBe(false);
      expect(ledger.readStates().some((s) => s.state === "interrupted" && s.reason === "budget_exceeded")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("TTY: continue_same segue até o teto; lower_effort reduz os restantes", async () => {
    for (const [choice, expected] of [["continue_same", 4], ["lower_effort", 3]] as const) {
      const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 1 });
      try {
        await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" },
          onBudgetExceeded: () => choice })).rejects.toBeDefined();
        expect(calls()).toBe(expected);
      } finally {
        stop();
      }
    }
  });
  test("ceiling cruzado no último step também para e registra o evento", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-budget-lastceiling-"));
    const server = Bun.serve({ port: 0, async fetch() {
      return Response.json({ choices: [{ message: { content: "fim" } }], usage: { prompt_tokens: 1000, completion_tokens: 0 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
          price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } }],
        agent: { model: "p/m", maxSteps: 2, tools: [] },
        budget: { scope: "day", limitUsd: 10, hardCeilingUsd: 1 },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => "continue_same" }))
        .rejects.toThrow(/budget esgotado \(ceiling\)/);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "ceiling_hit")).toBe(true);
      expect(ledger.readStates().find((s) => s.state === "interrupted")?.reason).toBe("budget_exceeded");
    } finally {
      server.stop(true);
    }
  });

  test("preço desconhecido com ceiling para antes de seguir (B6/I-17)", async () => {
    const { cwd, configPath, calls, stop } = await runWithBudget({ scope: "day", limitUsd: 10, hardCeilingUsd: 1 }, 10, false);
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, onBudgetExceeded: () => "continue_same" }))
        .rejects.toThrow(/budget esgotado \(unknown_price\)/);
      expect(calls()).toBe(1);
      expect(new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll()
        .some((e) => e.tipo === "budget.exceeded" && (e.payload as { reason?: string }).reason === "unknown_price")).toBe(true);
    } finally {
      stop();
    }
  });

});
