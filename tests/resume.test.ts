import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { ReplayIncompleteError, planResume, rebuildAgentTree } from "../src/resume";
import { runMultiAgentSession, runSession, type MultiAgentSessionOptions, type SessionOptions } from "../src/session";
import { handoffTool } from "../src/tools/handoff";
import { ToolExecutor } from "../src/tools/executor";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const newLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "astro-resume-")), "ledger.jsonl"));

/** Semeia uma cadeia planner → coder, encerrada (completed). */
function seedChain(ledger: Ledger, run = "r1"): void {
  ledger.recordAgentCreated({ run, agent_id: "planner", session_id: run, model: "m1", profile: "premium" });
  ledger.recordAgentDestroyed({ run, agent_id: "planner", session_id: run, reason: "handoff" });
  ledger.recordAgentCreated({ run, agent_id: "coder", parent_agent_id: "planner", session_id: run, model: "m2" });
  ledger.recordAgentDestroyed({ run, agent_id: "coder", session_id: run, reason: "completed" });
  ledger.recordState(run, "completed", { agent: "coder" });
}

describe("reconstrução da árvore de agentes (F-22, #131)", () => {
  test("reconstrói cadeia planner→coder com parent, model e profile gravados", () => {
    const ledger = newLedger();
    seedChain(ledger);
    const tree = rebuildAgentTree(ledger, "r1");
    expect(tree.roots).toEqual(["planner"]);
    expect(tree.nodes.map((n) => n.agent_id)).toEqual(["planner", "coder"]);
    expect(tree.nodes[1]).toMatchObject({ agent_id: "coder", parent_agent_id: "planner", model: "m2", reason: "completed" });
    expect(tree.nodes[0]).toMatchObject({ model: "m1", profile: "premium", reason: "handoff" });
    expect(tree.active).toBeUndefined();
    expect(rebuildAgentTree(ledger, "r1")).toEqual(tree); // determinístico
  });

  test("golden §11.11: run multi-agent real reconstrói a árvore e os modelos", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-resume-run-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o", maxSteps: 2, tools: [] },
    };
    const registry = {
      requireAgent: (name: string): AgentEntry => agents[name] ?? (() => { throw new Error(`agent "${name}" não encontrado`); })(),
      getAgent: (name: string): AgentEntry | undefined => agents[name],
      resolveModel: (agent: AgentEntry): ModelEntry => {
        const [provider, id] = agent.model.split("/");
        return { provider: provider!, id: id!, tags: ["writing-code"], context: 128000, status: "active" };
      },
    };
    let calls = 0;
    const provider: Provider = { complete: async () => {
      calls++;
      return calls === 1
        ? resp({ toolCalls: [{ id: "h1", name: "handoff",
          arguments: JSON.stringify({ to: "coder", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }) }] })
        : resp({ content: "feito" });
    } };
    const opts: MultiAgentSessionOptions = {
      run: "run-1", credentialRef: "K", quotaDomain: "default", cwd, provider, registry, baseModel: model,
      baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "planner",
    };
    const result = await runMultiAgentSession(opts, "delegue");

    const tree = rebuildAgentTree(ledger, "run-1");
    expect(tree.nodes.map((n) => n.agent_id)).toEqual(["planner", "coder"]);
    expect(tree.nodes[1]).toMatchObject({ parent_agent_id: "planner", model: "gpt-4o" });
    expect(tree.nodes[0]!.model).toBe("gpt-4o-mini"); // modelo gravado, sem recálculo
    expect(tree.active).toBeUndefined();
    expect(result.steps).toBe(2);
  });

  test("árvore quebrada → replay_incomplete (sem resume parcial)", () => {
    const ledger = newLedger();
    ledger.recordAgentDestroyed({ run: "r1", agent_id: "ghost", session_id: "r1", reason: "x" });
    expect(() => rebuildAgentTree(ledger, "r1")).toThrow(ReplayIncompleteError);
    expect(() => rebuildAgentTree(ledger, "r1")).toThrow(/replay incompleto/);

    const dup = newLedger();
    dup.recordAgentCreated({ run: "r1", agent_id: "a", session_id: "r1", model: "m" });
    dup.recordAgentCreated({ run: "r1", agent_id: "a", session_id: "r1", model: "m" });
    expect(() => rebuildAgentTree(dup, "r1")).toThrow(/criado duas vezes/);

    const twoRoots = newLedger();
    twoRoots.recordAgentCreated({ run: "r1", agent_id: "a", session_id: "r1", model: "m" });
    twoRoots.recordAgentCreated({ run: "r1", agent_id: "b", session_id: "r1", model: "m" });
    expect(() => rebuildAgentTree(twoRoots, "r1")).toThrow(/raízes/);
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

    const empty = newLedger();
    expect(() => planResume(empty, "r1")).toThrow(ReplayIncompleteError);
  });

  test("cancelamento deixa o agente ativo para retomada (F-06 + F-22)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-resume-abort-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const controller = new AbortController();
    const provider: Provider = { complete: async () => {
      controller.abort(new Error("cancelado"));
      throw new Error("cancelado");
    } };
    const opts: SessionOptions = {
      run: "r-abort", agent: "default", credentialRef: "K", quotaDomain: "default", cwd, provider, model,
      executor: new ToolExecutor({ tools: [], allow: [], audit }), ledger, audit, maxSteps: 3, signal: controller.signal,
    };

    await expect(runSession(opts, "tarefa")).rejects.toBeDefined();
    const tree = rebuildAgentTree(ledger, "r-abort");
    expect(tree.active).toMatchObject({ agent_id: "default" });
    expect(planResume(ledger, "r-abort").agent.agent_id).toBe("default");
  });
});
