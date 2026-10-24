import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { callId, CallJournal } from "../src/call-id";
import { Ledger } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession, runMultiAgentSession, type SessionOptions, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolResult } from "../src/tools/types";

const dir = () => mkdtempSync(join(tmpdir(), "astro-dedup-"));

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};

/** Tool falsa que conta execuções. */
function countingTool(name = "counter"): { tool: Tool; runs: () => number } {
  let runs = 0;
  const tool: Tool = {
    manifest: {
      name, description: "conta execuções",
      parameters: { type: "object", properties: {} },
      risk: "low", permission: "test", timeoutMs: 5000, retryable: false,
    },
    async execute(): Promise<ToolResult> {
      runs++;
      return { output: `exec ${runs}` };
    },
  };
  return { tool, runs: () => runs };
}

const ctxBase = (dirPath: string) => ({ cwd: dirPath, run: "r1", agent: "default" });

describe("dedup no ToolExecutor (F-03)", () => {
  test("mesmo call_id no mesmo step: executa 1x, devolve registrado, audita tool.dedup", async () => {
    const { tool, runs } = countingTool();
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const ex = new ToolExecutor({ tools: [tool], allow: ["counter"], audit });
    const journal = new CallJournal();
    const call = { id: "c1", name: "counter", arguments: "{}" };
    const r1 = await ex.run({ ...ctxBase(dir()), step: 1, journal }, call);
    const r2 = await ex.run({ ...ctxBase(dir()), step: 1, journal }, call);
    expect(runs()).toBe(1);
    expect(r2).toEqual(r1);
    const events = audit.readAll();
    expect(events.filter((e) => e.tipo === "tool.dedup")).toHaveLength(1);
    expect(events.filter((e) => e.tipo === "tool.call")).toHaveLength(1);
    expect(events.filter((e) => e.tipo === "tool.result")).toHaveLength(1);
    expect(events.find((e) => e.tipo === "tool.dedup")!.payload.callId).toBe(callId("r1", 1, call));
  });

  test("step diferente re-executa (leitura pós-escrita não serve resultado velho)", async () => {
    const { tool, runs } = countingTool();
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const ex = new ToolExecutor({ tools: [tool], allow: ["counter"], audit });
    const journal = new CallJournal();
    const call = { id: "c1", name: "counter", arguments: "{}" };
    await ex.run({ ...ctxBase(dir()), step: 1, journal }, call);
    await ex.run({ ...ctxBase(dir()), step: 2, journal }, call);
    expect(runs()).toBe(2);
    expect(audit.readAll().filter((e) => e.tipo === "tool.dedup")).toHaveLength(0);
  });

  test("arguments diferentes no mesmo step re-executam", async () => {
    const { tool, runs } = countingTool();
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const ex = new ToolExecutor({ tools: [tool], allow: ["counter"], audit });
    const journal = new CallJournal();
    await ex.run({ ...ctxBase(dir()), step: 1, journal }, { id: "c1", name: "counter", arguments: "{}" });
    await ex.run({ ...ctxBase(dir()), step: 1, journal }, { id: "c2", name: "counter", arguments: '{"n":2}' });
    expect(runs()).toBe(2);
  });

  test("sem step/journal no ctx: sem dedup (compat)", async () => {
    const { tool, runs } = countingTool();
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const ex = new ToolExecutor({ tools: [tool], allow: ["counter"], audit });
    const call = { id: "c1", name: "counter", arguments: "{}" };
    await ex.run(ctxBase(dir()), call);
    await ex.run(ctxBase(dir()), call);
    expect(runs()).toBe(2);
    expect(audit.readAll().filter((e) => e.tipo === "tool.dedup")).toHaveLength(0);
    expect(audit.readAll().filter((e) => e.tipo === "tool.call")).toHaveLength(2);
  });

  test("resultado de erro também é deduplicado", async () => {
    let runs = 0;
    const tool: Tool = {
      manifest: {
        name: "boomer", description: "sempre falha",
        parameters: { type: "object", properties: {} },
        risk: "low", permission: "test", timeoutMs: 5000, retryable: false,
      },
      async execute(): Promise<ToolResult> {
        runs++;
        return { output: "boom", isError: true };
      },
    };
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const ex = new ToolExecutor({ tools: [tool], allow: ["boomer"], audit });
    const journal = new CallJournal();
    const call = { id: "c1", name: "boomer", arguments: "{}" };
    const r1 = await ex.run({ ...ctxBase(dir()), step: 1, journal }, call);
    const r2 = await ex.run({ ...ctxBase(dir()), step: 1, journal }, call);
    expect(runs).toBe(1);
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
  });

  test("tool.call e tool.result carregam callId quando há step/journal", async () => {
    const { tool } = countingTool();
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const ex = new ToolExecutor({ tools: [tool], allow: ["counter"], audit });
    const journal = new CallJournal();
    const call = { id: "c1", name: "counter", arguments: "{}" };
    await ex.run({ ...ctxBase(dir()), step: 3, journal }, call);
    const events = audit.readAll();
    expect(events.find((e) => e.tipo === "tool.call")!.payload.callId).toBe(callId("r1", 3, call));
    expect(events.find((e) => e.tipo === "tool.result")!.payload.callId).toBe(callId("r1", 3, call));
  });
});

describe("dedup nas sessões (F-03)", () => {
  test("single-agent: dois calls idênticos no mesmo step executam 1x", async () => {
    const cwd = dir();
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const { tool, runs } = countingTool();
    const script: CompletionResponse[] = [
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "counter", arguments: "{}" },
          { id: "c2", name: "counter", arguments: "{}" },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { content: "pronto", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    let i = 0;
    const provider: Provider = { complete: async () => script[i++] };
    const opts: SessionOptions = {
      run: "r1", agent: "default", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [tool], allow: ["counter"], audit }),
      ledger, audit, maxSteps: 5,
    };
    const r = await runSession(opts, "dup");
    expect(r.final).toBe("pronto");
    expect(runs()).toBe(1);
    expect(audit.readAll().filter((e) => e.tipo === "tool.dedup")).toHaveLength(1);
  });

  test("multi-agent: journal compartilhado entre steps sobrevive à troca de executor", async () => {
    const cwd = dir();
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const { tool, runs } = countingTool();
    const script: CompletionResponse[] = [
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "counter", arguments: "{}" },
          { id: "c2", name: "counter", arguments: "{}" },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { content: "feito", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    let i = 0;
    const provider: Provider = { complete: async () => script[i++] };
    const agents = { coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["counter"] } };
    const registry = {
      requireAgent(name: string) {
        const a = agents[name as keyof typeof agents];
        if (!a) throw new Error(`agent "${name}" não encontrado`);
        return a;
      },
      getAgent(name: string) {
        return agents[name as keyof typeof agents];
      },
    };
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry, baseModel: model,
      baseExecutor: new ToolExecutor({ tools: [tool], allow: ["counter"], audit }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "coder",
    };
    const r = await runMultiAgentSession(opts, "dup multi");
    expect(r.final).toBe("feito");
    expect(runs()).toBe(1);
    expect(audit.readAll().filter((e) => e.tipo === "tool.dedup")).toHaveLength(1);
  });

  test("multi-agent: mesmo call em step diferente re-executa", async () => {
    const cwd = dir();
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const { tool, runs } = countingTool();
    const script: CompletionResponse[] = [
      { content: "", toolCalls: [{ id: "c1", name: "counter", arguments: "{}" }], usage: { inputTokens: 10, outputTokens: 5 } },
      { content: "", toolCalls: [{ id: "c2", name: "counter", arguments: "{}" }], usage: { inputTokens: 10, outputTokens: 5 } },
      { content: "fim", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    let i = 0;
    const provider: Provider = { complete: async () => script[i++] };
    const agents = { coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["counter"] } };
    const registry = {
      requireAgent(name: string) {
        const a = agents[name as keyof typeof agents];
        if (!a) throw new Error(`agent "${name}" não encontrado`);
        return a;
      },
      getAgent(name: string) {
        return agents[name as keyof typeof agents];
      },
    };
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry, baseModel: model,
      baseExecutor: new ToolExecutor({ tools: [tool], allow: ["counter"], audit }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "coder",
    };
    await runMultiAgentSession(opts, "re-executa");
    expect(runs()).toBe(2);
  });
});
