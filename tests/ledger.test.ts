import { expect, test } from "bun:test";
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
