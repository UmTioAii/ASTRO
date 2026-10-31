import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";

const dir = () => mkdtempSync(join(tmpdir(), "astro-seq-lock-"));

/** Dois processos filhos escrevem no mesmo arquivo ao mesmo tempo. */
async function race(writer: string, path: string): Promise<void> {
  // Barreira comum: sem ela o startup de um filho termina depois do outro.
  const startAt = Date.now() + 800;
  const code = `const target = ${JSON.stringify(path)};
const startAt = Number(process.env.START_AT ?? 0);
while (Date.now() < startAt) {}
${writer}`;
  const spawn = () =>
    Bun.spawn({
      cmd: [process.execPath, "-e", code],
      cwd: process.cwd(),
      env: { ...process.env, START_AT: String(startAt) },
      stdout: "pipe",
      stderr: "pipe",
    });
  const children = [spawn(), spawn()];
  const codes = await Promise.all(children.map((child) => child.exited));
  expect(codes).toEqual([0, 0]);
}

const moduleUrl = (name: string) => pathToFileURL(join(import.meta.dir, "..", "src", name)).href;

test("ledger: dois processos geram seq único e sequencial", async () => {
  const path = join(dir(), "ledger.jsonl");
  const writer = `
const { Ledger } = await import(${JSON.stringify(moduleUrl("ledger.ts"))});
const l = new Ledger(target, { warn: () => {} });
for (let i = 0; i < 10; i++) {
  l.record({ run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 1 });
}`;
  await race(writer, path);

  const seqs = new Ledger(path, { warn: () => {} }).readAllEntries().map((e) => e.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});

test("audit: dois processos geram seq único e sequencial", async () => {
  const path = join(dir(), "audit.jsonl");
  const writer = `
const { Auditor } = await import(${JSON.stringify(moduleUrl("audit.ts"))});
const a = new Auditor(target);
for (let i = 0; i < 10; i++) a.append({ run: "r", tipo: "x" });`;
  await race(writer, path);

  const seqs = new Auditor(path).readAll().map((e) => e.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});
