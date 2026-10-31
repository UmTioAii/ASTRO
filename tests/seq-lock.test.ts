import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
const N = 5; // por processo; 2×N no total
const moduleUrl = (name: string) => pathToFileURL(join(import.meta.dir, "..", "src", name)).href;

/** Dois filhos escrevem no mesmo arquivo ao mesmo tempo, atrás de uma barreira comum. */
async function race(writer: string, path: string): Promise<void> {
  const code = `const target = ${JSON.stringify(path)};
const startAt = Number(process.env.START_AT ?? 0);
while (Date.now() < startAt) {}
${writer}`;
  const children = [0, 1].map(() => Bun.spawn({
    cmd: [process.execPath, "-e", code],
    cwd: process.cwd(),
    env: { ...process.env, START_AT: String(Date.now() + 800) },
    stdout: "pipe",
    stderr: "pipe",
  }));
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
}
const expected = () => Array.from({ length: N * 2 }, (_, i) => i + 1);

test("ledger: dois processos geram seq único e sequencial", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-seq-lock-")), "ledger.jsonl");
  await race(`
const { Ledger } = await import(${JSON.stringify(moduleUrl("ledger.ts"))});
const l = new Ledger(target, { warn: () => {} });
for (let i = 0; i < ${N}; i++) {
  l.record({ run: "r", agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 1 });
}`, path);

  const seqs = new Ledger(path, { warn: () => {} }).readAllEntries().map((e) => e.seq ?? 0).sort((a, b) => a - b);
  expect(seqs).toEqual(expected());
});

test("audit: dois processos geram seq único e sequencial", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-seq-lock-")), "audit.jsonl");
  await race(`
const { Auditor } = await import(${JSON.stringify(moduleUrl("audit.ts"))});
const a = new Auditor(target);
for (let i = 0; i < ${N}; i++) a.append({ run: "r", tipo: "x" });`, path);

  const seqs = new Auditor(path).readAll().map((e) => e.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(expected());
});
