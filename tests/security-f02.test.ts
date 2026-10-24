import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger, hashToolCalls } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { writeFileTool } from "../src/tools/write-file";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};

/** Segredo falso construído em runtime (não casa o padrão do gate G6 no diff). */
const fakeSecret = ["s", "k", "-", "a1", "b2", "c3", "d4", "e5", "f6", "g7"].join("");

test("F-02/I-03: args com segredo não chegam ao ledger; só o hash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-sec-f02-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledgerPath = join(cwd, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath);
  const script: CompletionResponse[] = [
    {
      content: "",
      toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "s.txt", content: fakeSecret }) }],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { content: "ok", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
  ];
  let i = 0;
  const provider: Provider = { complete: async () => script[i++] };
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
    cwd, provider, model,
    executor: new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger, audit, maxSteps: 5,
  };
  await runSession(opts, "teste");
  const text = readFileSync(ledgerPath, "utf8");
  expect(text).not.toContain(fakeSecret);
  expect(text).toContain("callHashes");
  const usage = ledger.readAll();
  expect(usage[0].callHashes).toHaveLength(1);
  expect(usage[0].callHashes![0]).toMatch(/^[0-9a-f]{64}$/);
});

test("F-02/I-03: hashToolCalls não devolve nem carrega o segredo", () => {
  const hashes = hashToolCalls([
    { name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: fakeSecret }) },
  ]);
  expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(hashes[0]).not.toContain(fakeSecret);
});
