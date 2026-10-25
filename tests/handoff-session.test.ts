import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { HandoffError, type HandoffDraft } from "../src/handoff/types";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { ToolExecutor } from "../src/tools/executor";
import { handoffTool } from "../src/tools/handoff";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const draft: HandoffDraft = {
  task: "implementar login", objective: "ter login funcionando", decisions: ["usar sessão"],
  constraints: ["sem dependência"], next_steps: ["testar"],
};
const dir = () => mkdtempSync(join(tmpdir(), "astro-f23s-"));
const handoffCall = (args: object) => resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", ...args }) }] });

function sessionOpts(agents: Record<string, AgentEntry>, provider: Provider, cwd = dir()): MultiAgentSessionOptions {
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  return {
    run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
    registry: {
      requireAgent: (name) => agents[name] as AgentEntry,
      getAgent: (name) => agents[name],
      listAgentNames: () => Object.keys(agents),
    },
    baseModel: model, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
    ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner",
  };
}

describe("tool handoff exige artefato (F-23)", () => {
  const ctx = (over: Record<string, unknown> = {}) => ({ cwd: ".", run: "r1", agent: "planner", step: 1, ...over });
  const args = (over: Record<string, unknown> = {}) => ({
    to: "coder", task: "t", objective: "o", decisions: ["d"], constraints: [], next_steps: ["n"], ...over,
  });

  test("entrada válida devolve handoff com draft normalizado", async () => {
    const out = await handoffTool.execute(args(), ctx());
    expect(JSON.parse(out.output)).toEqual({
      handoff: true, to: "coder",
      draft: { task: "t", objective: "o", decisions: ["d"], constraints: [], next_steps: ["n"] },
    });
  });

  test("artefato inválido falha com handoff_artifact_mismatch, não retentável", async () => {
    const err = await handoffTool.execute(args({ objective: undefined }), ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(HandoffError);
    expect(err.code).toBe("handoff_artifact_mismatch");
    expect(err.retryable).toBe(false);
    expect(err.errClass).toBe("invalid_request");
  });

  test("destino fora da config falha com handoff_target_not_found", async () => {
    const err = await handoffTool.execute(args({ to: "ghost" }), ctx({ knownAgents: ["planner", "coder"] }))
      .catch((e) => e);
    expect(err.code).toBe("handoff_target_not_found");
    expect(err.message).toContain("ghost");
  });
});

describe("handoff durável na sessão multi-agent (F-23)", () => {
  const agents = {
    planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"], profile: "premium" },
    coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: [], profile: "cheap" },
  };

  test("created e received no ledger; troca só depois; budget e profiles preenchidos", async () => {
    let i = 0;
    const provider: Provider = { complete: async () => (i++ === 0 ? handoffCall(draft) : resp({ content: "done" })) };
    const opts = sessionOpts(agents, provider);
    const result = await runMultiAgentSession(opts, "plan");
    expect(result.agentsUsed).toEqual(["planner", "coder"]);

    const handoffs = opts.ledger.readHandoffs();
    expect(handoffs.map((e) => e.kind)).toEqual(["handoff.created", "handoff.received"]);
    expect(handoffs[0].handoff_id).toBe(handoffs[1].handoff_id);
    expect(handoffs[0].artifact).toMatchObject({
      source_step: 1, from_profile: "premium", to_profile: "cheap", budget_spent: { tokens: 15 },
    });
    expect(handoffs[0].artifact.budget_spent.usd).toBeCloseTo(0.000015, 12);

    const tipos = opts.audit.readAll().map((e) => e.tipo);
    expect(tipos.indexOf("handoff.created")).toBeLessThan(tipos.indexOf("agent.switch"));
    expect(tipos.indexOf("agent.switch")).toBeLessThan(tipos.indexOf("handoff.received"));
  });

  test("queda após gravar created: artefato sobrevive sem received", async () => {
    class CrashLedger extends Ledger {
      override recordHandoff(...args: Parameters<Ledger["recordHandoff"]>) {
        if (args[0] === "handoff.received") throw new Error("queda simulada");
        return super.recordHandoff(...args);
      }
    }
    const cwd = dir();
    const opts = sessionOpts(agents, { complete: async () => handoffCall(draft) }, cwd);
    opts.ledger = new CrashLedger(join(cwd, "ledger.jsonl"));
    await expect(runMultiAgentSession(opts, "plan")).rejects.toThrow("queda simulada");
    const handoffs = new Ledger(join(cwd, "ledger.jsonl")).readHandoffs();
    expect(handoffs.map((e) => e.kind)).toEqual(["handoff.created"]);
    expect(handoffs[0].artifact.task).toBe(draft.task);
  });
});
