import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { buildHandoffArtifact } from "../src/handoff/types";
import { Ledger, type LedgerAgentEntry } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { ReplayIncompleteError, planResume, rebuildAgentTree } from "../src/resume";
import { runMultiAgentSession, runSession, type MultiAgentSessionOptions, type SessionOptions } from "../src/session";
import { handoffTool } from "../src/tools/handoff";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool } from "../src/tools/types";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const newLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "astro-resume-")), "ledger.jsonl"));

/** Sessão single-agent em cwd temporário. */
function single(run: string, provider: Provider, extra: Partial<SessionOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), `astro-${run}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const opts: SessionOptions = { run, agent: "default", credentialRef: "K", quotaDomain: "default", cwd, provider, model,
    executor: new ToolExecutor({ tools: [], allow: [], audit }), ledger, audit, maxSteps: 3, ...extra };
  return { opts, audit, ledger };
}

/** Sessão multi-agent com registry em memória. */
function multi(run: string, provider: Provider, agents: Record<string, AgentEntry>, tools: readonly Tool[] = [handoffTool], allow = ["handoff"]) {
  const cwd = mkdtempSync(join(tmpdir(), `astro-${run}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const registry = {
    requireAgent: (name: string): AgentEntry => agents[name] ?? (() => { throw new Error(`agent "${name}" não encontrado`); })(),
    getAgent: (name: string): AgentEntry | undefined => agents[name],
    resolveModel: (agent: AgentEntry): ModelEntry => { const [provider, id] = agent.model.split("/"); return { provider: provider!, id: id!, tags: ["writing-code"], context: 128000, status: "active" }; },
  };
  const opts: MultiAgentSessionOptions = { run, credentialRef: "K", quotaDomain: "default", cwd, provider, registry, baseModel: model,
    baseExecutor: new ToolExecutor({ tools: [...tools], allow, audit }), ledger, audit, baseMaxSteps: 5, entryAgent: "planner" };
  return { opts, audit, ledger };
}

/** Semeia uma cadeia planner → coder, encerrada (completed). */
function seedChain(ledger: Ledger, run = "r1"): void {
  ledger.recordAgentCreated({ run, agent_id: "planner", session_id: run, model: "m1", profile: "premium" });
  ledger.recordAgentDestroyed({ run, agent_id: "planner", session_id: run, reason: "handoff" });
  ledger.recordAgentCreated({ run, agent_id: "coder", parent_agent_id: "planner", session_id: run, model: "m2" });
  ledger.recordAgentDestroyed({ run, agent_id: "coder", session_id: run, reason: "completed" });
  ledger.recordState(run, "completed", { agent: "coder" });
}

describe("reconstrução da árvore de agentes (F-22, #131)", () => {
  test("golden §11.11: run multi-agent real reconstrói a árvore e os modelos", async () => {
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o", maxSteps: 2, tools: [] },
    };
    let calls = 0;
    const provider: Provider = { complete: async () => {
      calls++;
      return calls === 1
        ? resp({ toolCalls: [{ id: "h1", name: "handoff",
          arguments: JSON.stringify({ to: "coder", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }) }] })
        : resp({ content: "feito" });
    } };
    const { opts, ledger } = multi("run-1", provider, agents);
    const result = await runMultiAgentSession(opts, "delegue");

    const tree = rebuildAgentTree(ledger, "run-1");
    expect(tree.nodes.map((n) => n.agent_id)).toEqual(["planner", "coder"]);
    expect(tree.nodes[1]).toMatchObject({ parent_agent_id: "planner", model: "gpt-4o" });
    expect(tree.nodes[0]!.model).toBe("gpt-4o-mini"); // gravado, sem recálculo
    expect(tree.active).toBeUndefined();
    expect(result.steps).toBe(2);
  });

  test("planResume: interrupted devolve agente ativo; completed e ausência de estado falham", () => {
    const ledger = newLedger();
    ledger.recordAgentCreated({ run: "r1", agent_id: "coder", session_id: "r1", model: "m2", profile: "p" });
    ledger.recordState("r1", "interrupted", { agent: "coder", reason: "cancelled" });
    const plan = planResume(ledger, "r1");
    expect(plan.agent).toMatchObject({ agent_id: "coder", model: "m2", profile: "p" });
    expect(plan.state).toBe("interrupted");

    const done = newLedger();
    seedChain(done);
    expect(() => planResume(done, "r1")).toThrow(/já concluído/);
    expect(() => planResume(newLedger(), "r1")).toThrow(ReplayIncompleteError);
  });

  test("cancelamento deixa o agente ativo para retomada (F-06 + F-22)", async () => {
    const controller = new AbortController();
    const provider: Provider = { complete: async () => {
      controller.abort(new Error("cancelado"));
      throw new Error("cancelado");
    } };
    const { opts, ledger } = single("r-abort", provider, { signal: controller.signal });
    await expect(runSession(opts, "tarefa")).rejects.toBeDefined();
    expect(rebuildAgentTree(ledger, "r-abort").active).toMatchObject({ agent_id: "default" });
    expect(planResume(ledger, "r-abort").agent.agent_id).toBe("default");
  });

  test("single-agent concluído: created + destroyed(completed) no ledger e audit", async () => {
    const provider: Provider = { complete: async () => resp({ content: "pronto" }) };
    const { opts, audit, ledger } = single("r-ok", provider);
    await runSession(opts, "tarefa");
    const tree = rebuildAgentTree(ledger, "r-ok");
    expect(tree.nodes).toHaveLength(1);
    expect(tree.active).toBeUndefined();
    expect(tree.nodes[0]!.reason).toBe("completed");
    const tipos = audit.readAll().map((e) => e.tipo);
    expect(tipos).toContain("agent.created");
    expect(tipos).toContain("agent.destroyed");
  });

  test("MaxSteps deixa o agente ativo (interrompível/retomável)", async () => {
    const provider: Provider = { complete: async () => resp({ toolCalls: [{ id: "c1", name: "ghost", arguments: "{}" }] }) };
    const { opts, ledger } = single("r-max", provider, { maxSteps: 1 });
    await expect(runSession(opts, "tarefa")).rejects.toBeDefined();
    expect(rebuildAgentTree(ledger, "r-max").active?.agent_id).toBe("default");
  });

  test("reabertura: handoff de volta a agente já usado o deixa ativo (sem duplicar nó)", () => {
    const ledger = newLedger();
    ledger.recordAgentCreated({ run: "r1", agent_id: "planner", session_id: "r1", model: "m1" });
    ledger.recordAgentDestroyed({ run: "r1", agent_id: "planner", session_id: "r1", reason: "handoff" });
    ledger.recordAgentCreated({ run: "r1", agent_id: "coder", parent_agent_id: "planner", session_id: "r1", model: "m2" });
    ledger.recordAgentDestroyed({ run: "r1", agent_id: "coder", session_id: "r1", reason: "handoff" });
    ledger.recordAgentCreated({ run: "r1", agent_id: "planner", session_id: "r1", model: "m1" });
    ledger.recordState("r1", "interrupted", { agent: "planner", reason: "cancelled" });

    const tree = rebuildAgentTree(ledger, "r1");
    expect(tree.roots).toEqual(["planner"]);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.nodes[1]).toMatchObject({ parent_agent_id: "planner", model: "m2", reason: "handoff" });
    expect(tree.nodes[0]).toMatchObject({ model: "m1" });
    expect(tree.active).toMatchObject({ agent_id: "planner", model: "m1" });
    expect(planResume(ledger, "r1").agent.agent_id).toBe("planner");
    expect(rebuildAgentTree(ledger, "r1")).toEqual(tree); // determinístico
  });

  test("self-handoff não destrói o agente que continua executando", async () => {
    const agents: Record<string, AgentEntry> = { planner: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff"] } };
    let calls = 0;
    const provider: Provider = { complete: async () => {
      calls++;
      return calls === 1
        ? resp({ toolCalls: [{ id: "h1", name: "handoff",
          arguments: JSON.stringify({ to: "planner", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }) }] })
        : resp({ content: "feito" });
    } };
    const { opts, ledger, audit } = multi("r-self", provider, agents);
    await runMultiAgentSession(opts, "delegue");
    const tree = rebuildAgentTree(ledger, "r-self");
    expect(tree.nodes).toHaveLength(1);
    expect(tree.active).toBeUndefined();
    expect(tree.nodes[0]!.reason).toBe("completed");
    // Guard de self-handoff: nenhum par destroyed/created espúrio (ledger e audit)
    const eventos = ledger.readAllEntries().filter((e): e is LedgerAgentEntry => e.kind === "agent").map((e) => `${e.event}:${e.agent_id}`);
    expect(eventos).toEqual(["created:planner", "destroyed:planner"]);
    expect(audit.readAll().filter((e) => e.tipo === "agent.created" || e.tipo === "agent.destroyed")).toHaveLength(2);
  });

  test("retomada de handoff pendente não duplica o nó do receptor", async () => {
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o", maxSteps: 2, tools: [] },
    };
    const { opts, ledger } = multi("r-pend", { complete: async () => resp({ content: "ok" }) }, agents);
    ledger.recordAgentCreated({ run: "r-pend", agent_id: "planner", session_id: "r-pend", model: "gpt-4o-mini" });
    const artifact = buildHandoffArtifact({ run: "r-pend", from: "planner", to: "coder", sourceStep: 1,
      budgetSpent: { tokens: 0, usd: 0 }, sourceRefs: { ledger_id: ledger.id(), seq_start: 1, seq_end: 1 },
      draft: { task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] } });
    ledger.recordHandoff("handoff.created", "r-pend", artifact, { agent: "planner" });

    expect((await runMultiAgentSession(opts, "delegue")).agentsUsed).toEqual(["coder"]);
    const tree = rebuildAgentTree(ledger, "r-pend");
    expect(tree.nodes).toHaveLength(2);
    expect(tree.nodes.filter((n) => n.agent_id === "coder")).toHaveLength(1);
    expect(tree.active).toBeUndefined();
    expect(tree.nodes[1]!.reason).toBe("completed");
  });

  test("planResume falha em árvore quebrada, evento sem seq e isola runs", () => {
    const create = (l: Ledger, id: string, parent?: string) =>
      l.recordAgentCreated({ run: "r1", agent_id: id, session_id: "r1", model: "m", ...(parent === undefined ? {} : { parent_agent_id: parent }) });
    const destroy = (l: Ledger, id: string) => l.recordAgentDestroyed({ run: "r1", agent_id: id, session_id: "r1", reason: "x" });
    const cases: [string, (l: Ledger) => void, RegExp][] = [
      ["pai inexistente", (l) => create(l, "child", "ghost"), /pai "ghost" inexistente/],
      ["dois ativos", (l) => { create(l, "a"); create(l, "b", "a"); }, /2 agentes ativos/],
      ["session divergente", (l) => l.recordAgentCreated({ run: "r1", agent_id: "a", session_id: "other", model: "m" }), /session_id/],
      ["destroyed sem created", (l) => destroy(l, "ghost"), /replay incompleto/],
      ["created duplicado", (l) => { create(l, "a"); create(l, "a"); }, /criado duas vezes/],
      ["duas raízes", (l) => { create(l, "a"); create(l, "b"); }, /raízes/],
      ["destroyed duplo", (l) => { create(l, "a"); destroy(l, "a"); destroy(l, "a"); }, /destruído duas vezes/],
    ];
    for (const [name, seed, error] of cases) {
      const ledger = newLedger();
      seed(ledger);
      expect(() => rebuildAgentTree(ledger, "r1")).toThrow(error);
    }

    const brokenPlan = newLedger();
    destroy(brokenPlan, "ghost");
    brokenPlan.recordState("r1", "interrupted", { reason: "cancelled" });
    expect(() => planResume(brokenPlan, "r1")).toThrow(ReplayIncompleteError);

    const noSeq = newLedger();
    appendFileSync(noSeq.path, `${JSON.stringify({ schemaVersion: 1, ts: "t", run: "r1", kind: "agent", event: "created", agent_id: "a", session_id: "r1" })}\n`);
    expect(() => rebuildAgentTree(noSeq, "r1")).toThrow(/sem seq/);

    const shared = newLedger();
    seedChain(shared, "r1");
    seedChain(shared, "r2");
    expect(rebuildAgentTree(shared, "r1").nodes).toHaveLength(2);
    expect(rebuildAgentTree(shared, "r2").nodes).toHaveLength(2);
  });
});
