import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit"; import { Ledger } from "../src/ledger";
import { buildHandoffArtifact, HandoffError, sanitizeHandoffArtifact, taskHash, type HandoffDraft } from "../src/handoff/types";
import { verifyHandoffIdentity } from "../src/handoff/verifier";
import { ackHandoff, scanHandoffs } from "../src/handoff/lifecycle";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor"; import { handoffTool } from "../src/tools/handoff";

const model: ModelEntry = { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active" };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const draft: HandoffDraft = { task: "via única", objective: "um único created", decisions: [], constraints: [], next_steps: [] };
const dir = () => mkdtempSync(join(tmpdir(), "astro-f26-"));
const handoffCall = (id = "c1") => resp({ toolCalls: [{ id, name: "handoff", arguments: JSON.stringify({ to: "coder", ...draft }) }] });
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

describe("lock de via única do handoff (F-26)", () => {
  test("CAS por handoff_id devolve o existente sem duplicar created nem received", () => {
    const ledger = new Ledger(join(dir(), "ledger.jsonl"));
    const a = seed(ledger);
    const again = ledger.recordHandoff("handoff.created", "r1", a, { agent: "planner" });
    const created = ledger.readHandoffs().filter((e) => e.kind === "handoff.created");
    expect(created).toHaveLength(1);
    expect(again.handoff_id).toBe(created[0]!.handoff_id);
    ledger.recordHandoff("handoff.received", "r1", a, { agent: "coder", receiverAgent: "coder" });
    const reack = ledger.recordHandoff("handoff.received", "r1", a, { agent: "coder", receiverAgent: "coder" });
    const received = ledger.readHandoffs().filter((e) => e.kind === "handoff.received");
    expect(received).toHaveLength(1);
    expect(reack.handoff_id).toBe(received[0]!.handoff_id);
    // id diferente não dedup: outra tarefa é outro handoff
    seed(ledger, "r2");
    expect(ledger.readHandoffs().filter((e) => e.kind === "handoff.created")).toHaveLength(2);
  });

  test("verifier: run|from|to|taskHash exatos; source_step com janela ±1", () => {
    const a = buildHandoffArtifact({ run: "r1", from: "planner", to: "coder", sourceStep: 2, budgetSpent: { tokens: 0, usd: 0 }, draft });
    const identity = { run: "r1", from: "planner", to: "coder", taskHash: taskHash(draft.task, draft.objective), source_step: 3 };
    verifyHandoffIdentity(identity, a); // ±1 tolerado
    verifyHandoffIdentity({ ...identity, source_step: 1 }, a); // ±1 para o outro lado
    const mismatch = (over: Partial<typeof identity>): HandoffError | undefined =>
      (() => { try { verifyHandoffIdentity({ ...identity, ...over }, a); } catch (e) { return e as HandoffError; } })();
    for (const over of [{ from: "ghost" }, { to: "ghost" }, { run: "r9" }, { taskHash: taskHash("outra tarefa", draft.objective) }, { source_step: 4 }]) {
      expect(mismatch(over)?.code).toBe("handoff_mismatch");
      expect(mismatch(over)?.retryable).toBe(false);
    }
  });

  test("ack rejeita handoff_id divergente do artefato com handoff_mismatch", () => {
    const ledgerPath = join(dir(), "ledger.jsonl");
    const ledger = new Ledger(ledgerPath);
    const a = seed(ledger, "r1");
    const bogus = "f".repeat(64);
    appendFileSync(ledgerPath, `${JSON.stringify({ schemaVersion: 1, ts: new Date().toISOString(), run: "r9", kind: "handoff.created", handoff_id: bogus, artifact: sanitizeHandoffArtifact(a), agent: "planner" })}\n`, "utf8");
    const err = (() => { try { ackHandoff({ ledger, run: "r9" }, bogus, "coder"); } catch (e) { return e as HandoffError; } })();
    expect(err?.code).toBe("handoff_mismatch");
    expect(ledger.readHandoffs().filter((e) => e.kind === "handoff.received")).toHaveLength(0);
  });

  test("duas chamadas de handoff no mesmo step com os mesmos argumentos produzem um único created", async () => {
    let calls = 0;
    const o = opts(dir(), { complete: async () => { calls++; return calls === 1 ? resp({ toolCalls: [
      { id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", ...draft }) },
      { id: "c2", name: "handoff", arguments: JSON.stringify({ to: "coder", ...draft }) },
    ] }) : resp({ content: "done" }); } });
    const result = await runMultiAgentSession(o, "plan");
    expect(result.final).toBe("done");
    const kinds = o.ledger.readHandoffs().map((e) => e.kind);
    expect(kinds).toEqual(["handoff.created", "handoff.received"]);
  });

  test("queda entre created e received: a retomada não duplica", async () => {
    const cwd = dir();
    const crash = opts(cwd, { complete: async () => handoffCall() }, { ackHandoff: () => { throw new Error("queda simulada"); } });
    await expect(runMultiAgentSession(crash, "plan")).rejects.toThrow("queda simulada");
    const o = opts(cwd, { complete: async () => resp({ content: "done" }) });
    const result = await runMultiAgentSession(o, "plan");
    expect(result.final).toBe("done");
    expect(result.agentsUsed).toEqual(["coder"]); // retoma direto no receptor
    const kinds = o.ledger.readHandoffs().map((e) => e.kind);
    expect(kinds).toEqual(["handoff.created", "handoff.received"]); // não duplicou
    expect(scanHandoffs(o.ledger, "r1")[0].state).toBe("completed");
  });

  test("created existente completed devolve o existente sem reexecutar", async () => {
    const cwd = dir();
    const o = opts(cwd, { complete: async () => handoffCall() });
    const a = seed(o.ledger); // mesmo run/from/to/taskHash/step → mesmo handoff_id
    o.ledger.recordHandoff("handoff.received", "r1", a, { agent: "coder", receiverAgent: "coder" });
    let calls = 0;
    const provider: Provider = { complete: async () => { calls++; return calls === 1 ? handoffCall() : resp({ content: "segue" }); } };
    const result = await runMultiAgentSession({ ...opts(cwd, provider), ledger: o.ledger, audit: o.audit }, "plan");
    expect(result.agentsUsed).toEqual(["planner"]); // sem troca: nada a reexecutar
    expect(result.final).toBe("segue");
    expect(o.ledger.readHandoffs().map((e) => e.kind)).toEqual(["handoff.created", "handoff.received"]); // nada novo
  });

  test("concorrência REAL: dois processos escrevem o mesmo handoff_id e produzem um único created", async () => {
    const ledgerPath = join(dir(), "ledger.jsonl");
    const worker = join(import.meta.dir, "cas-worker.ts");
    const child = () => {
      const proc = Bun.spawn([process.execPath, worker, ledgerPath, "r1"], { stdout: "pipe", stderr: "pipe" });
      return { exit: proc.exited, out: new Response(proc.stdout).text() };
    };
    const [first, second] = [child(), child()];
    await Promise.all([first.exit, second.exit]);
    const [idA, idB] = [(await first.out).trim(), (await second.out).trim()];
    expect(idA).toBe(idB); // ambos devolvem o mesmo handoff_id
    const ledger = new Ledger(ledgerPath);
    const created = ledger.readHandoffs().filter((e) => e.kind === "handoff.created");
    expect(created).toHaveLength(1);
    expect(created[0]!.handoff_id).toBe(idA);
  });
});
