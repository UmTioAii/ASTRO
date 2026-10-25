import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit"; import { Ledger } from "../src/ledger";
import { buildHandoffArtifact, handoffId, HandoffError, type HandoffArtifactV1, type HandoffDraft } from "../src/handoff/types";
import { ackHandoff, scanHandoffs } from "../src/handoff/lifecycle";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { MaxStepsError, runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor"; import { handoffTool } from "../src/tools/handoff";

const model: ModelEntry = { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active" };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const draft: HandoffDraft = { task: "implementar login", objective: "ter login funcionando", decisions: ["usar sessão"], constraints: ["sem dependência"], next_steps: ["testar"] };
const dir = () => mkdtempSync(join(tmpdir(), "astro-f24-"));
const handoffCall = (to = "coder") => resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to, ...draft }) }] });
const agents: Record<string, AgentEntry> = { planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] }, coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: [] } };
function opts(cwd: string, provider: Provider, over: Partial<MultiAgentSessionOptions> = {}): MultiAgentSessionOptions {
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  return { run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
    registry: { requireAgent: (n) => agents[n] as AgentEntry, getAgent: (n) => agents[n], listAgentNames: () => Object.keys(agents) },
    baseModel: model, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
    ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner", ...over };
}
const seed = (ledger: Ledger, run = "r1") => {
  const artifact = buildHandoffArtifact({ run, from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 }, draft });
  ledger.recordHandoff("handoff.created", run, artifact, { agent: "planner" });
  return artifact;
};

describe("handoff com ack e retomada (F-24)", () => {
  test("scan distingue pending, completed e failed; isola por run e por ledger", () => {
    const ledger = new Ledger(join(dir(), "ledger.jsonl"));
    const a1 = seed(ledger, "r1"), a2 = seed(ledger, "r2");
    expect(scanHandoffs(ledger, "r1")).toHaveLength(1);
    expect(scanHandoffs(ledger, "r1")[0].state).toBe("pending");
    ledger.recordHandoff("handoff.received", "r1", a1, { agent: "coder", receiverAgent: "coder" });
    expect(scanHandoffs(ledger, "r1")[0].state).toBe("completed");
    ledger.recordHandoff("handoff.failed", "r1", a1, { agent: "coder", reason: "MaxStepsError" });
    const failed = scanHandoffs(ledger, "r1")[0];
    expect(failed.state).toBe("failed"); expect(failed.reason).toBe("MaxStepsError");
    ledger.recordHandoff("handoff.ack_timeout", "r2", a2, { agent: "planner", reason: "sem ack em 5ms" });
    expect(scanHandoffs(ledger, "r2")[0].state).toBe("pending"); // ack_timeout volta a pending
    const other = new Ledger(join(dir(), "ledger.jsonl")); // ledger de outro cwd
    expect(scanHandoffs(other, "r1")).toHaveLength(0); // não vê pendentes do primeiro cwd
  });

  test("receptor lê o artefato do ledger, valida o schema e grava received", () => {
    const ledger = new Ledger(join(dir(), "ledger.jsonl"));
    const a = seed(ledger);
    const id = handoffId(a);
    const received = ackHandoff({ ledger, run: "r1" }, id, "coder");
    expect(received.task).toBe(draft.task);
    const events = ledger.readHandoffs();
    expect(events.map((e) => e.kind)).toEqual(["handoff.created", "handoff.received"]);
    expect(events[1].handoff_id).toBe(id);
    expect(events[1].receiver_agent).toBe("coder");
    expect(events[1].received_at).toBeDefined();
    expect(() => ackHandoff({ ledger, run: "r1" }, "deadbeef", "coder")).toThrow(/não encontrado no ledger/);
    const badBase = buildHandoffArtifact({ run: "r9", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 }, draft });
    const bad = { ...badBase, version: 2 } as unknown as HandoffArtifactV1;
    ledger.recordHandoff("handoff.created", "r9", bad, { agent: "planner" });
    const err = (() => { try { ackHandoff({ ledger, run: "r9" }, handoffId(badBase), "coder"); } catch (e) { return e as HandoffError; } })();
    expect(err?.code).toBe("handoff_artifact_mismatch");
    expect(scanHandoffs(ledger, "r9")[0].state).toBe("pending"); // sem received
  });

  test("sem ack no timeout grava handoff.ack_timeout e o emissor recebe erro retriable", async () => {
    const o = opts(dir(), { complete: async () => handoffCall() }, { ackTimeoutMs: 5, ackHandoff: () => new Promise(() => {}) });
    const err = await runMultiAgentSession(o, "plan").then(() => null, (e) => e as HandoffError);
    expect(err).toBeInstanceOf(HandoffError);
    expect((err as HandoffError).code).toBe("handoff_ack_timeout");
    expect((err as HandoffError).retryable).toBe(true);
    const events = o.ledger.readHandoffs();
    const created = events.find((e) => e.kind === "handoff.created")!;
    expect(events.some((e) => e.kind === "handoff.ack_timeout")).toBe(true);
    expect((err as HandoffError).message).toContain(created.handoff_id);
    const status = scanHandoffs(o.ledger, "r1");
    expect(status).toHaveLength(1); expect(status[0].state).toBe("pending");
    expect(o.audit.readAll().some((e) => e.tipo === "handoff.ack_timeout")).toBe(true);
  });

  test("queda entre created e received: reinicialização retoma no receptor sem perda de contexto", async () => {
    const cwd = dir();
    const crash = opts(cwd, { complete: async () => handoffCall() }, { ackHandoff: () => { throw new Error("queda simulada"); } });
    await expect(runMultiAgentSession(crash, "plan")).rejects.toThrow("queda simulada");
    expect(crash.ledger.readHandoffs().map((e) => e.kind)).toEqual(["handoff.created"]);
    const requests: CompletionRequest[] = [];
    const o = opts(cwd, { complete: async (req) => { requests.push(req); return resp({ content: "retomado" }); } });
    const result = await runMultiAgentSession(o, "plan");
    expect(result.agentsUsed[0]).toBe("coder"); // pendente continua no receptor
    expect(result.final).toBe("retomado");
    const first = JSON.stringify(requests[0].messages);
    expect(first).toContain(draft.task); // artefato no contexto da primeira chamada
    const events = o.ledger.readHandoffs();
    expect(events.map((e) => e.kind)).toEqual(["handoff.created", "handoff.received"]);
    expect(events[1].receiver_agent).toBe("coder");
    expect(events[1].received_at).toBeDefined();
  });

  test("handoff falho permanente é reportado e não reexecutado na retomada", async () => {
    const o = opts(dir(), { complete: async () => { throw new Error("receptor não deveria rodar"); } });
    const a = seed(o.ledger);
    o.ledger.recordHandoff("handoff.received", "r1", a, { agent: "coder", receiverAgent: "coder" });
    o.ledger.recordHandoff("handoff.failed", "r1", a, { agent: "coder", reason: "MaxStepsError" });
    const err = await runMultiAgentSession(o, "plan").then(() => null, (e) => e as Error);
    expect(err?.message).toContain(handoffId(a));
    expect(err?.message).toContain("MaxStepsError");
    expect(o.ledger.readHandoffs().filter((e) => e.kind === "handoff.received")).toHaveLength(1);
  });

  test("falha pós-ack grava handoff.failed com reason", async () => {
    let calls = 0;
    const o = opts(dir(), { complete: async () => { calls++; if (calls === 1) return handoffCall(); throw new MaxStepsError(5, "agente parou"); } });
    const err = await runMultiAgentSession(o, "plan").then(() => null, (e) => e as Error);
    expect(err).toBeInstanceOf(MaxStepsError);
    const events = o.ledger.readHandoffs();
    expect(events.map((e) => e.kind)).toEqual(["handoff.created", "handoff.received", "handoff.failed"]);
    expect(events[2].reason).toBe("MaxStepsError");
    expect(scanHandoffs(o.ledger, "r1")[0].state).toBe("failed");
  });
});
