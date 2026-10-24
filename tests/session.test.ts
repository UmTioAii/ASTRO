import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { MaxStepsError, runSession, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { handoffTool } from "../src/tools/handoff";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

function setup(script: CompletionResponse[]) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-session-"));
  const requests: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = { complete: async (req) => { requests.push(req); return script[i++]; } };
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
    cwd, provider, model, executor: new ToolExecutor({ tools: [], allow: [], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { cwd, opts, requests, ledger };
}

test("resposta direta: 1 passo, 1 entrada no ledger", async () => {
  const { opts, ledger } = setup([resp({ content: "pronto" })]);
  const r = await runSession(opts, "diga oi");
  expect(r.final).toBe("pronto");
  expect(r.steps).toBe(1);
  expect(ledger.readAll()).toHaveLength(1);
  expect(ledger.readAll()[0].tokensIn).toBe(10);
});

test("um round de tool e depois resposta final", async () => {
  const s = setup([
    resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] }),
    resp({ content: "feito" }),
  ]);
  s.opts.executor = new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit: s.opts.audit });
  const r = await runSession(s.opts, "crie a.txt");
  expect(r.final).toBe("feito");
  expect(r.steps).toBe(2);
  expect(s.ledger.readAll()).toHaveLength(2);
  expect(readFileSync(join(s.cwd, "a.txt"), "utf8")).toBe("x");
});

test("erro de tool volta ao modelo como mensagem e a sessão segue", async () => {
  const s = setup([
    resp({ toolCalls: [{ id: "c1", name: "read_file", arguments: "nao-json" }] }),
    resp({ content: "ok" }),
  ]);
  s.opts.executor = new ToolExecutor({ tools: [readFileTool], allow: ["read_file"], audit: s.opts.audit });
  const r = await runSession(s.opts, "leia");
  expect(r.final).toBe("ok");
  const last = s.requests[1].messages.at(-1)!;
  expect(last.role).toBe("tool");
  expect(last.toolCallId).toBe("c1");
  expect(last.content.length).toBeGreaterThan(0);
});

test("estoura maxSteps → MaxStepsError", async () => {
  const tc = resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] });
  const s = setup([tc, tc]);
  s.opts.executor = new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit: s.opts.audit });
  s.opts.maxSteps = 2;
  const err = await runSession(s.opts, "loop").catch((e) => e as Error);
  expect(err).toBeInstanceOf(MaxStepsError);
});

describe("estado de execução e callHashes no ledger (F-02)", () => {
  test("sessão normal grava callHashes por entrada e estado completed", async () => {
    const s = setup([
      resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] }),
      resp({ content: "feito" }),
    ]);
    s.opts.executor = new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit: s.opts.audit });
    await runSession(s.opts, "crie a.txt");
    const usage = s.ledger.readAll();
    expect(usage[0].schemaVersion).toBe(1);
    expect(usage[0].callHashes).toHaveLength(1);
    expect(usage[1].callHashes).toEqual([]);
    const st = s.ledger.lastState("r1")!;
    expect(st.state).toBe("completed");
    expect(st.agent).toBe("default");
  });

  test("erro na sessão grava estado interrupted com reason", async () => {
    const tc = resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] });
    const s = setup([tc, tc]);
    s.opts.executor = new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit: s.opts.audit });
    s.opts.maxSteps = 2;
    await runSession(s.opts, "loop").catch(() => undefined);
    const st = s.ledger.lastState("r1")!;
    expect(st.state).toBe("interrupted");
    expect(st.reason).toBe("MaxStepsError");
  });

  test("HandoffSignal não grava estado de execução", async () => {
    const s = setup([
      resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "planner", payload: {} }) }] }),
    ]);
    s.opts.executor = new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit: s.opts.audit });
    const err = await runSession(s.opts, "transfira").then(() => null).catch((e: unknown) => e);
    expect((err as { name?: string }).name).toBe("HandoffSignal");
    expect(s.ledger.lastState("r1")).toBeUndefined();
  });
});
