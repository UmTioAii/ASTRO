import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { HandoffDraft } from "../src/handoff/types";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry } from "../src/registry";
import { ToolExecutor } from "../src/tools/executor";
import { handoffTool } from "../src/tools/handoff";
import { runMultiAgentSession } from "../src/session";

const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });

describe("segurança F-23: segredo não chega ao ledger nem ao audit (I-03)", () => {
  test("sessão multi-agent sanitiza created/received e agent.switch", async () => {
    // Segredos montados em runtime para não vazar literais no diff (G6)
    const NV = ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890";
    const SK = ["s", "k", "-"].join("") + "abcdef1234567890";
    const BEARER = ["B", "e", "a", "r", "e", "r"].join("") + " abcdef1234567890";
    const draft: HandoffDraft = {
      task: `tarefa ${NV}`, objective: `objetivo ${BEARER}`, decisions: [`decisão ${SK}`, NV], constraints: [], next_steps: [BEARER] };
    const cwd = mkdtempSync(join(tmpdir(), "astro-f23-sec-s-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] }, coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: [] },
    };
    let i = 0;
    const provider: Provider = {
      complete: async () => i++ === 0
        ? resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", ...draft }) }] })
        : resp({ content: "ok" }),
    };
    await runMultiAgentSession({
      run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
      registry: {
        requireAgent: (name) => agents[name] as AgentEntry,
        getAgent: (name) => agents[name],
        listAgentNames: () => Object.keys(agents),
      },
      baseModel: { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active" },
      baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
      ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner",
    }, "plan");
    for (const path of [join(cwd, "ledger.jsonl"), join(cwd, "audit.jsonl")]) {
      const raw = readFileSync(path, "utf8");
      for (const secret of [NV, SK, BEARER]) expect(raw).not.toContain(secret);
    }
  });
});
