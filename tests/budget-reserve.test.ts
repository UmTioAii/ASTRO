import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { budgetStatus, outstandingReservations } from "../src/budget";
import type { BudgetConfig } from "../src/config";
import { Ledger } from "../src/ledger";

interface Row {
  kind?: "usage" | "budget";
  event?: "reserved" | "released";
  costUsd?: number | null;
  reserved?: number;
  released?: number;
  actual_cost?: number;
  ts?: string;
  run?: string;
}

function ledgerWith(rows: Row[]): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "astro-budget-res-"));
  const path = join(dir, "ledger.jsonl");
  rows.forEach((row, index) => appendFileSync(path, `${JSON.stringify({
    schemaVersion: 1, ts: row.ts ?? new Date().toISOString(), run: "r1", agent: "a", provider: "p", model: "m",
    credentialRef: "K", quotaDomain: "default", ...(row.kind === "budget" ? {} : { tokensIn: 1, tokensOut: 1 }),
    ...row, seq: index + 1,
  })}\n`));
  return new Ledger(path);
}

const budget = (extra: Partial<BudgetConfig> = {}): BudgetConfig =>
  ({ scope: "day", limitUsd: 10, warnAt: 0.8, onExceed: "ask", ...extra });

describe("reserva da cadeia (B9, #132 parte 4)", () => {
  test("reserved sem released conta como custo real (crash recovery)", () => {
    const ledger = ledgerWith([
      { kind: "usage", costUsd: 2 },
      { kind: "budget", event: "reserved", reserved: 5 },
    ]);
    expect(outstandingReservations(ledger)).toBe(5);
    expect(budgetStatus(budget(), ledger).spentUsd).toBe(7);
  });

  test("released libera a reserva e não duplica o custo", () => {
    const ledger = ledgerWith([
      { kind: "usage", costUsd: 2 },
      { kind: "budget", event: "reserved", reserved: 5 },
      { kind: "budget", event: "released", released: 5, actual_cost: 2 },
    ]);
    expect(outstandingReservations(ledger)).toBe(0);
    expect(budgetStatus(budget(), ledger).spentUsd).toBe(2);
  });

  test("reserva órfã fora da janela (mês anterior) não conta no escopo day", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const ledger = ledgerWith([{ kind: "budget", event: "reserved", reserved: 5, ts: yesterday }]);
    expect(outstandingReservations(ledger, () => false)).toBe(0);
    expect(budgetStatus(budget(), ledger).spentUsd).toBe(0);
  });

  test("release de um run não apaga a reserva órfã de outro", () => {
    const ledger = ledgerWith([
      { kind: "budget", event: "reserved", reserved: 5, run: "old" },
      { kind: "usage", costUsd: 2 },
      { kind: "budget", event: "reserved", reserved: 1, run: "r1" },
      { kind: "budget", event: "released", released: 1, actual_cost: 1, run: "r1" },
    ]);
    expect(outstandingReservations(ledger)).toBe(5);
    expect(budgetStatus(budget(), ledger).spentUsd).toBe(7);
  });

  test("reservas são liberadas em FIFO", () => {
    const ledger = ledgerWith([
      { kind: "budget", event: "reserved", reserved: 1 },
      { kind: "budget", event: "reserved", reserved: 2 },
      { kind: "budget", event: "released", released: 1, actual_cost: 0 },
    ]);
    expect(outstandingReservations(ledger)).toBe(2);
  });
});

/** Run que devolve resposta final com custo `usage` (preço US$ 1000/M). */
async function runOnce(budgetCfg: Record<string, unknown>, seed?: (ledgerPath: string) => void, extra: Record<string, unknown> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-budget-res-run-"));
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() {
    calls++;
    return Response.json({ choices: [{ message: { content: "fim" } }], usage: { prompt_tokens: 1000, completion_tokens: 0 } });
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192,
      price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } }],
    agent: { model: "p/m", maxSteps: 2, tools: [] },
    budget: budgetCfg,
    ...extra,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  if (seed !== undefined) {
    mkdirSync(join(cwd, ".astro"), { recursive: true });
    seed(join(cwd, ".astro", "ledger.jsonl"));
  }
  return { cwd, configPath, calls: () => calls, stop: () => server.stop(true) };
}

/** Config com profile `cheap` → fallback `big` (modelo caro). */
async function profileRun() {
  const cwd = mkdtempSync(join(tmpdir(), "astro-budget-profile-"));
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() {
    calls++;
    return Response.json({ choices: [{ message: { content: "fim" } }], usage: { prompt_tokens: 8192, completion_tokens: 0 } });
  } });
  const base = `http://127.0.0.1:${server.port}/v1`;
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: base, credentialRef: "KEY" }, q: { kind: "openai-compat", baseUrl: base, credentialRef: "KEY" } },
    models: [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192, price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
      { provider: "q", id: "m2", tags: ["writing-code"], context: 8192, price: { inputPerM: 1000, outputPerM: 1000, fonte: "t", verificado: false } },
    ],
    modelPool: { cheap: { model: "p/m1", fallback: ["big"] }, big: { model: "q/m2" } },
    agent: { profile: "cheap", maxSteps: 2, tools: [] },
    budget: { scope: "day", limitUsd: 2 },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath, calls: () => calls, stop: () => server.stop(true) };
}

describe("reserva no run (B9, #132 parte 4)", () => {
  test("cada chamada reserva a cadeia e libera com o custo real", async () => {
    const { cwd, configPath, stop } = await runOnce({ scope: "day", limitUsd: 10 });
    try {
      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      const budgetEvents = ledger.readAllEntries().filter((e) => e.kind === "budget");
      const reserved = budgetEvents.find((e) => e.kind === "budget" && e.event === "reserved");
      const released = budgetEvents.find((e) => e.kind === "budget" && e.event === "released");
      expect(reserved && reserved.kind === "budget" ? reserved.reserved : 0).toBeCloseTo(8.192, 3);
      expect(released && released.kind === "budget" ? released.actual_cost : null).toBeCloseTo(1, 6);
      expect(outstandingReservations(ledger)).toBe(0);
      expect(report.budget?.spentUsd).toBeCloseTo(1, 6);
    } finally {
      stop();
    }
  });

  test("reserva órfã consome o orçamento disponível antes de nova chamada", async () => {
    const { cwd, configPath, calls, stop } = await runOnce({ scope: "day", limitUsd: 4 }, (ledgerPath) => {
      appendFileSync(ledgerPath, `${JSON.stringify({
        schemaVersion: 1, ts: new Date().toISOString(), run: "old", agent: "a", kind: "budget",
        event: "reserved", reserved: 5, seq: 1,
      })}\n`);
    });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } }))
        .rejects.toThrow(/budget esgotado/);
      expect(calls()).toBe(0);
    } finally {
      stop();
    }
  });

  test("fallback de profile entra na reserva (B9/F-31)", async () => {
    const { cwd, configPath, calls, stop } = await profileRun();
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } }))
        .rejects.toThrow(/budget esgotado/);
      expect(calls()).toBe(0); // reserva do profile caro já estoura o limite
    } finally {
      stop();
    }
  });

  test("parada por team antes do budget não deixa reserva órfã", async () => {
    const { cwd, configPath, stop } = await runOnce({ scope: "day", limitUsd: 100 }, undefined, { team: { projectBudgetUsd: 0 } });
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toBeDefined();
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().some((e) => e.kind === "budget" && e.event === "reserved")).toBe(false);
    } finally {
      stop();
    }
  });
});
