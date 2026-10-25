import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit"; import { Ledger } from "../src/ledger";
import { HandoffError, type HandoffDraft } from "../src/handoff/types";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession, runSession } from "../src/session";
import { ToolExecutor } from "../src/tools/executor"; import { handoffTool } from "../src/tools/handoff";
import { OtlpTracer } from "../src/tracing";

const model: ModelEntry = { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active" };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const draft: HandoffDraft = { task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] };
const registry = (list: Record<string, AgentEntry>) => ({ requireAgent: (n: string) => list[n] as AgentEntry, getAgent: (n: string) => list[n], listAgentNames: () => Object.keys(list) });
// Segredos montados em runtime para não vazar literais no diff (G6)
const secrets = () => ({ NV: ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890", SK: ["s", "k", "-"].join("") + "abcdef1234567890", BEARER: ["B", "e", "a", "r", "e", "r"].join("") + " abcdef1234567890" });

describe("segurança F-23: segredo não chega ao ledger, audit nem prompt (I-03)", () => {
  test("segredo em agente e artefato fica fora de ledger, audit, requests e spans", async () => {
    const { NV, SK, BEARER } = secrets();
    const OPAQUE = "segredo-opaco-123";
    const TO = `coder-${NV}`, RUN = `run-${NV}`;
    const cwd = mkdtempSync(join(tmpdir(), "astro-f23-sec-"));
    const audit = new Auditor(join(cwd, "audit.jsonl")), ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const list: Record<string, AgentEntry> = { planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] }, [TO]: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: [] } };
    const requests: CompletionRequest[] = [];
    const tracer = new OtlpTracer("http://127.0.0.1:1");
    const provider: Provider = { complete: async (req) => {
      requests.push(req);
      return requests.length === 1 ? resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({
        to: TO, task: `tarefa ${NV}`, objective: `objetivo ${BEARER}`, decisions: [SK], constraints: [], next_steps: [NV],
      }) }] }) : resp({ content: "ok" });
    } };
    const result = await runMultiAgentSession({ run: RUN, credentialRef: "K", quotaDomain: "d", cwd, provider, registry: registry(list),
      baseModel: model, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "planner", tracer }, "plan");
    audit.append({ run: RUN, tipo: "probe", payload: { authorization: { value: OPAQUE }, token: [NV] } });
    const raw = JSON.stringify(requests) + readFileSync(join(cwd, "ledger.jsonl"), "utf8") + readFileSync(join(cwd, "audit.jsonl"), "utf8") + JSON.stringify(tracer.recorded());
    for (const secret of [NV, SK, BEARER, OPAQUE, TO, RUN]) expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
    expect(result.agentsUsed[1]).not.toContain(NV);
    expect(ledger.readHandoffs()[0].artifact.budget_spent.tokens).toBe(15);
    expect(ledger.lastState(RUN)?.state).toBe("completed");
  });
  test("single-agent nega destino fora da config e redige a mensagem", async () => {
    const { NV } = secrets();
    const TO = `ghost-${NV}`;
    const cwd = mkdtempSync(join(tmpdir(), "astro-f23-single-"));
    const audit = new Auditor(join(cwd, "audit.jsonl")), ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const provider: Provider = { complete: async () => resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: TO, ...draft }) }] }) };
    const err = await runSession({ run: "r1", agent: "planner", credentialRef: "K", quotaDomain: "d", cwd, provider,
      model, executor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }), ledger, audit, maxSteps: 2 }, "plan")
      .then(() => null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffError);
    expect((err as HandoffError).code).toBe("handoff_target_not_found");
    expect((err as HandoffError).message).not.toContain(NV);
    expect((err as HandoffError).message).toContain("[REDACTED]");
    expect(ledger.readHandoffs()).toHaveLength(0);
    const bad = await handoffTool.execute({ to: "coder" }, { cwd: ".", run: "r1", agent: "planner", step: 1 }).then(() => null, (e: HandoffError) => e);
    expect(bad?.code).toBe("handoff_artifact_mismatch");
  });
});
