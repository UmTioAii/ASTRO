import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";

const dir = () => mkdtempSync(join(tmpdir(), "astro-ledger-"));
const entry = {
  run: "r1", agent: "default", provider: "openai", model: "gpt-4o-mini",
  credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
  tokensIn: 1000, tokensOut: 500,
};

test("registra e calcula custo por 1M de tokens (cria subdiretório)", () => {
  const l = new Ledger(join(dir(), "sub", "ledger.jsonl"));
  const e = l.record(structuredClone(entry), { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false });
  expect(e.costUsd).toBeCloseTo(0.002, 10); // 1000/1e6*1 + 500/1e6*2
});

test("sem preço curado → costUsd null + aviso", () => {
  const warns: string[] = [];
  const l = new Ledger(join(dir(), "ledger.jsonl"), { warn: (m) => warns.push(m) });
  const e = l.record(structuredClone(entry), undefined);
  expect(e.costUsd).toBeNull();
  expect(warns.length).toBe(1);
});

test("total soma tokens e custo", () => {
  const l = new Ledger(join(dir(), "ledger.jsonl"));
  const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
  l.record(structuredClone(entry), price);
  l.record(structuredClone(entry), price);
  const t = l.total();
  expect(t.tokensIn).toBe(2000);
  expect(t.tokensOut).toBe(1000);
  expect(t.costUsd).toBeCloseTo(0.003, 10);
});

test("readAll lê o JSONL persistido entre instâncias", () => {
  const path = join(dir(), "ledger.jsonl");
  const first = new Ledger(path).record(structuredClone(entry), {
    inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false,
  });
  const all = new Ledger(path).readAll();
  expect(all).toHaveLength(1);
  expect(all[0]).toEqual(first);
  expect(all[0].ts).toBeTruthy();
});

describe("byAgent (F3-3)", () => {
  test("agrega por agent no mesmo run", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner", tokensIn: 100, tokensOut: 50 }, price);
    l.record({ ...entry, agent: "coder", tokensIn: 200, tokensOut: 100 }, price);
    l.record({ ...entry, agent: "reviewer", tokensIn: 50, tokensOut: 25 }, price);
    l.record({ ...entry, agent: "coder", tokensIn: 100, tokensOut: 50 }, price);

    const byAgent = l.byAgent();
    expect(Object.keys(byAgent).sort()).toEqual(["coder", "planner", "reviewer"]);
    expect(byAgent.planner.tokensIn).toBe(100);
    expect(byAgent.planner.tokensOut).toBe(50);
    expect(byAgent.coder.tokensIn).toBe(300);
    expect(byAgent.coder.tokensOut).toBe(150);
    expect(byAgent.reviewer.tokensIn).toBe(50);
    expect(byAgent.reviewer.tokensOut).toBe(25);
  });

  test("byAgent soma costUsd", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner", tokensIn: 1000, tokensOut: 500 }, price);
    l.record({ ...entry, agent: "coder", tokensIn: 1000, tokensOut: 500 }, price);

    const byAgent = l.byAgent();
    expect(byAgent.planner.costUsd).toBeCloseTo(0.002, 10);
    expect(byAgent.coder.costUsd).toBeCloseTo(0.002, 10);
  });

  test("byAgent com costUsd null trata como 0", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    l.record({ ...entry, agent: "planner" }, undefined);
    const byAgent = l.byAgent();
    expect(byAgent.planner.costUsd).toBe(0);
  });

  test("um run com 3 agents mostra 3 entradas com agent diferentes", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner" }, price);
    l.record({ ...entry, agent: "coder" }, price);
    l.record({ ...entry, agent: "reviewer" }, price);

    const all = l.readAll();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((e) => e.agent))).toEqual(new Set(["planner", "coder", "reviewer"]));
    expect(new Set(all.map((e) => e.run))).toEqual(new Set(["r1"]));
  });
});
