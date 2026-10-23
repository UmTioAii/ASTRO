import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";

const dir = () => mkdtempSync(join(tmpdir(), "astro-audit-"));

test("append escreve JSONL com seq incremental", () => {
  const path = join(dir(), "audit.jsonl");
  const a = new Auditor(path);
  a.append({ run: "r1", tipo: "run.started", payload: { n: 1 } });
  a.append({ run: "r1", tipo: "run.completed" });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]).seq).toBe(2);
});

test("seq continua de arquivo existente", () => {
  const path = join(dir(), "audit.jsonl");
  new Auditor(path).append({ run: "r1", tipo: "run.started" });
  const ev = new Auditor(path).append({ run: "r2", tipo: "run.started" });
  expect(ev.seq).toBe(2);
});

test("redige segredos no payload", () => {
  const path = join(dir(), "audit.jsonl");
  new Auditor(path).append({
    run: "r1", tipo: "x",
    payload: { apiKey: "sk-abc123456789", nested: { authorization: "Bearer zzz" }, ok: "fine" },
  });
  const raw = readFileSync(path, "utf8");
  expect(raw).not.toContain("sk-abc123456789");
  expect(raw).not.toContain("Bearer zzz");
  expect(raw).toContain("[REDACTED]");
});

test("cria o diretório do arquivo se não existir", () => {
  const path = join(dir(), "sub", "deep", "audit.jsonl");
  new Auditor(path).append({ run: "r1", tipo: "x" });
  expect(JSON.parse(readFileSync(path, "utf8")).run).toBe("r1");
});
