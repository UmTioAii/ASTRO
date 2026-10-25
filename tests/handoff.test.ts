import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { runCommandTool } from "../src/tools/run-command";
import type { Tool } from "../src/tools/types";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { handoffTool } from "../src/tools/handoff";
import type { AgentEntry } from "../src/registry";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

function makeExecutor(tools: Tool[], allow: string[], audit: Auditor) {
  return new ToolExecutor({ tools, allow, audit });
}

function makeRegistry(agents: Record<string, AgentEntry>) {
  return {
    requireAgent(name: string): AgentEntry {
      const a = agents[name];
      if (!a) throw new Error(`agent "${name}" não encontrado`);
      return a;
    },
    getAgent(name: string): AgentEntry | undefined {
      return agents[name];
    },
  };
}

describe("handoff tool (F3-2)", () => {
  test("handoff tool existe no manifesto", () => {
    expect(handoffTool.manifest.name).toBe("handoff");
    expect(handoffTool.manifest.risk).toBe("medium");
    expect(handoffTool.manifest.permission).toBe("handoff");
    const params = handoffTool.manifest.parameters as { properties: Record<string, unknown> };
    expect(params.properties).toHaveProperty("to");
    expect(params.properties).toHaveProperty("task");
  });

  test("handoff válido troca agent no contexto via runMultiAgentSession", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-handoff-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";

    const agents = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"], systemPrompt: "Planeje" },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["read_file", "write_file", "run_command"], systemPrompt: "Code" },
    };
    const registry = makeRegistry(agents);

    let step = 0;
    const provider: Provider = {
      complete: async (req) => {
        step++;
        if (step === 1) {
          return resp({
            toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", task: "write file", objective: "arquivo escrito", decisions: [], constraints: [], next_steps: [] }) }],
          });
        }
        return resp({ content: "done" });
      },
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry,
      baseModel: model,
      baseExecutor: makeExecutor([handoffTool, readFileTool, writeFileTool, runCommandTool], ["handoff", "read_file", "write_file", "run_command"], audit),
      ledger, audit, baseMaxSteps: 5,
      entryAgent: "planner",
    };

    const result = await runMultiAgentSession(opts, "plan and hand off");
    expect(result.final).toBe("done");
    expect(result.steps).toBe(2);
    expect(result.agentsUsed).toEqual(["planner", "coder"]);

    const events = audit.readAll();
    const switchEvent = events.find((e) => e.tipo === "agent.switch");
    expect(switchEvent).toBeDefined();
    expect(switchEvent!.payload.from).toBe("planner");
    expect(switchEvent!.payload.to).toBe("coder");
  });

  test("handoff para agent inexistente lança erro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-handoff-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";

    const agents = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] },
    };
    const registry = makeRegistry(agents);

    const provider: Provider = {
      complete: async () => resp({
        toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "ghost", task: "x", objective: "y", decisions: [], constraints: [], next_steps: [] }) }],
      }),
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry,
      baseModel: model,
      baseExecutor: makeExecutor([handoffTool], ["handoff"], audit),
      ledger, audit, baseMaxSteps: 5,
      entryAgent: "planner",
    };

    const err = await runMultiAgentSession(opts, "handoff to ghost")
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("ghost");
    const st = ledger.lastState(run)!;
    expect(st.state).toBe("interrupted");
    expect(st.reason).toBeTruthy();
  });
});

describe("runMultiAgentSession (F3-2)", () => {
  test("planner → coder → reviewer completa tarefa em 3 steps", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-multi-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";

    const agents = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"], systemPrompt: "Planeje" },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff", "write_file"], systemPrompt: "Code" },
      reviewer: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["read_file"], systemPrompt: "Review" },
    };
    const registry = makeRegistry(agents);

    let step = 0;
    const provider: Provider = {
      complete: async () => {
        step++;
        if (step === 1) {
          return resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", task: "implementar", objective: "código pronto", decisions: [], constraints: [], next_steps: [] }) }] });
        }
        if (step === 2) {
          return resp({ toolCalls: [{ id: "c2", name: "handoff", arguments: JSON.stringify({ to: "reviewer", task: "revisar", objective: "aprovação", decisions: [], constraints: [], next_steps: [] }) }] });
        }
        return resp({ content: "approved" });
      },
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry,
      baseModel: model,
      baseExecutor: makeExecutor([handoffTool, readFileTool, writeFileTool, runCommandTool], ["handoff", "read_file", "write_file", "run_command"], audit),
      ledger, audit, baseMaxSteps: 10,
      entryAgent: "planner",
    };

    const result = await runMultiAgentSession(opts, "full cycle");
    expect(result.final).toBe("approved");
    expect(result.steps).toBe(3);
    expect(result.agentsUsed).toEqual(["planner", "coder", "reviewer"]);

    // F3-3: ledger tem 3 entradas com agents diferentes no mesmo run
    const ledgerEntries = ledger.readAll();
    expect(ledgerEntries).toHaveLength(3);
    expect(new Set(ledgerEntries.map((e) => e.agent))).toEqual(new Set(["planner", "coder", "reviewer"]));
    expect(new Set(ledgerEntries.map((e) => e.run))).toEqual(new Set(["r1"]));
    // byAgent agrega corretamente
    const byAgent = ledger.byAgent();
    expect(Object.keys(byAgent).sort()).toEqual(["coder", "planner", "reviewer"]);
    expect(byAgent.planner.tokensIn).toBe(10);
    expect(byAgent.coder.tokensIn).toBe(10);
    expect(byAgent.reviewer.tokensIn).toBe(10);

    const events = audit.readAll();
    const switches = events.filter((e) => e.tipo === "agent.switch");
    expect(switches).toHaveLength(2);
    expect(switches[0].payload.from).toBe("planner");
    expect(switches[0].payload.to).toBe("coder");
    expect(switches[1].payload.from).toBe("coder");
    expect(switches[1].payload.to).toBe("reviewer");
  });

  test("F-02: uso multi-agent carrega callHashes e estado de execução", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-multi-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";
    const agents = { coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["write_file"] } };
    const registry = makeRegistry(agents);

    let step = 0;
    const provider: Provider = {
      complete: async () => {
        step++;
        if (step === 1) {
          return resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] });
        }
        return resp({ content: "done" });
      },
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry, baseModel: model,
      baseExecutor: makeExecutor([writeFileTool], ["write_file"], audit),
      ledger, audit, baseMaxSteps: 5, entryAgent: "coder",
    };

    await runMultiAgentSession(opts, "escreva");
    const usage = ledger.readAll();
    expect(usage).toHaveLength(2);
    expect(usage[0].schemaVersion).toBe(1);
    expect(usage[0].callHashes).toHaveLength(1);
    expect(usage[1].callHashes).toEqual([]);
    const st = ledger.lastState(run)!;
    expect(st.state).toBe("completed");
    expect(st.agent).toBe("coder");
  });
});