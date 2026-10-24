import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LEDGER_SCHEMA_VERSION, hashToolCalls } from "../src/ledger";

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

describe("schemaVersion (F-02, ADR-0002)", () => {
  test("record preenche schemaVersion e kind automaticamente", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const e = l.record(structuredClone(entry), undefined);
    expect(e.schemaVersion).toBe(1);
    expect(e.kind).toBe("usage");
    expect(LEDGER_SCHEMA_VERSION).toBe(1);
  });

  test("entrada antiga sem schemaVersion ainda soma em total()", () => {
    const path = join(dir(), "ledger.jsonl");
    const old = { ...entry, ts: "2026-01-01T00:00:00Z", costUsd: null };
    writeFileSync(path, `${JSON.stringify(old)}\n`, "utf8");
    const l = new Ledger(path);
    l.record({ ...entry, tokensIn: 10, tokensOut: 5 }, undefined);
    const t = l.total();
    expect(t.tokensIn).toBe(1010);
    expect(t.tokensOut).toBe(505);
  });
});

describe("estado de execução (F-02)", () => {
  test("recordState grava entrada run_state com agent e reason", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const s = l.recordState("r1", "interrupted", { agent: "default", reason: "MaxStepsError" });
    expect(s.schemaVersion).toBe(1);
    expect(s.kind).toBe("run_state");
    expect(s.state).toBe("interrupted");
    expect(s.agent).toBe("default");
    expect(s.reason).toBe("MaxStepsError");
    expect(s.ts).toBeTruthy();
  });

  test("readAll devolve só uso; readAllEntries devolve tudo na ordem", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    l.record(structuredClone(entry), undefined);
    l.recordState("r1", "interrupted");
    l.record(structuredClone(entry), undefined);
    l.recordState("r1", "completed");
    expect(l.readAll()).toHaveLength(2);
    const all = l.readAllEntries();
    expect(all).toHaveLength(4);
    expect(all[1].kind).toBe("run_state");
    expect(all[3].kind).toBe("run_state");
    expect(l.readStates()).toHaveLength(2);
  });

  test("total e byAgent ignoram entradas de estado (sem NaN)", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    l.record(structuredClone(entry), undefined);
    l.recordState("r1", "interrupted");
    const t = l.total();
    expect(Number.isNaN(t.tokensIn)).toBe(false);
    expect(t.tokensIn).toBe(1000);
    const byAgent = l.byAgent();
    expect(byAgent.default.tokensIn).toBe(1000);
  });

  test("lastState devolve a última entrada de estado do run", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    expect(l.lastState("r1")).toBeUndefined();
    l.recordState("r1", "interrupted");
    l.recordState("r2", "completed");
    l.recordState("r1", "completed");
    expect(l.lastState("r1")!.state).toBe("completed");
    expect(l.lastState("r2")!.state).toBe("completed");
  });
});

describe("hashToolCalls (F-02)", () => {
  test("um hash SHA-256 por call, determinístico", () => {
    const calls = [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }];
    const h1 = hashToolCalls(calls);
    const h2 = hashToolCalls(calls);
    expect(h1).toHaveLength(1);
    expect(h1[0]).toBe(h2[0]);
    expect(h1[0]).toBe(
      createHash("sha256")
        .update(JSON.stringify({ name: "read_file", arguments: calls[0].arguments }))
        .digest("hex"),
    );
  });

  test("nome e arguments alteram o hash; sem calls devolve vazio", () => {
    const a = hashToolCalls([{ name: "read_file", arguments: "{}" }]);
    const b = hashToolCalls([{ name: "write_file", arguments: "{}" }]);
    const c = hashToolCalls([{ name: "read_file", arguments: '{"path":"x"}' }]);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).not.toBe(c[0]);
    expect(hashToolCalls([])).toEqual([]);
  });
});
