import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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
import { runMultiAgentSession, MaxStepsError, type MultiAgentSessionOptions } from "../src/session";
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

describe("runMultiAgentSession supervisor (F3-4)", () => {
  test("maxSteps por agent: agent excede limite próprio → erro claro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-orch-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";

    // coder tem maxSteps: 2, mas fará 3 steps
    const agents = {
      coder: { model: "openai/gpt-4o-mini", maxSteps: 2, tools: ["write_file"] },
    };
    const registry = makeRegistry(agents);

    let callCount = 0;
    const writeCall = { id: "c", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) };
    const provider: Provider = {
      complete: async () => {
        callCount++;
        return resp({ toolCalls: [writeCall] });
      },
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry,
      baseModel: model,
      baseExecutor: makeExecutor([writeFileTool], ["write_file"], audit),
      ledger, audit, baseMaxSteps: 10, // global alto
      entryAgent: "coder",
    };

    const err = await runMultiAgentSession(opts, "loop")
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(MaxStepsError);
    expect(err!.message).toContain("coder");
    expect(callCount).toBe(2); // parou no limite do agent, não no global
  });

  test("maxSteps global: soma de todos agents não excede baseMaxSteps", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-orch-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";

    const agents = {
      a: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] },
      b: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] },
    };
    const registry = makeRegistry(agents);

    let step = 0;
    const provider: Provider = {
      complete: async () => {
        step++;
        // alterna handoff a→b→a→b...
        const to = step % 2 === 1 ? "b" : "a";
        return resp({ toolCalls: [{ id: `c${step}`, name: "handoff", arguments: JSON.stringify({ to }) }] });
      },
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry,
      baseModel: model,
      baseExecutor: makeExecutor([handoffTool], ["handoff"], audit),
      ledger, audit, baseMaxSteps: 5, // global baixo
      entryAgent: "a",
    };

    const err = await runMultiAgentSession(opts, "ping-pong")
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(MaxStepsError);
    expect(step).toBe(5); // parou no global, não no per-agent
  });

  test("golden: tarefa complexa resolvida por 3 agents em < 15 steps", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-golden-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const run = "r1";

    const agents = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["handoff"], systemPrompt: "Planeje e delegue" },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 8, tools: ["handoff", "write_file", "read_file", "run_command"], systemPrompt: "Escreva código" },
      reviewer: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["read_file"], systemPrompt: "Revise" },
    };
    const registry = makeRegistry(agents);

    // Simula fluxo real: planner planeja (1) → coder escreve 2 arquivos (3) → reviewer revisa (2) = 6 steps
    let step = 0;
    const provider: Provider = {
      complete: async () => {
        step++;
        if (step === 1) {
          // planner: delega ao coder
          return resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", payload: { plan: "create hello and utils" } }) }] });
        }
        if (step === 2) {
          // coder: escreve hello.ts
          return resp({ toolCalls: [{ id: "c2", name: "write_file", arguments: JSON.stringify({ path: "hello.ts", content: "export function hello() { return 'hello'; }" }) }] });
        }
        if (step === 3) {
          // coder: escreve utils.ts
          return resp({ toolCalls: [{ id: "c3", name: "write_file", arguments: JSON.stringify({ path: "utils.ts", content: "export function add(a: number, b: number) { return a + b; }" }) }] });
        }
        if (step === 4) {
          // coder: delega ao reviewer
          return resp({ toolCalls: [{ id: "c4", name: "handoff", arguments: JSON.stringify({ to: "reviewer", payload: { files: ["hello.ts", "utils.ts"] } }) }] });
        }
        if (step === 5) {
          // reviewer: lê hello.ts
          return resp({ toolCalls: [{ id: "c5", name: "read_file", arguments: JSON.stringify({ path: "hello.ts" }) }] });
        }
        if (step === 6) {
          // reviewer: lê utils.ts
          return resp({ toolCalls: [{ id: "c6", name: "read_file", arguments: JSON.stringify({ path: "utils.ts" }) }] });
        }
        // reviewer: aprova
        return resp({ content: "Aprovado: código limpo e correto." });
      },
    };

    const opts: MultiAgentSessionOptions = {
      run, credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
      cwd, provider, registry,
      baseModel: model,
      baseExecutor: makeExecutor([handoffTool, readFileTool, writeFileTool, runCommandTool], ["handoff", "read_file", "write_file", "run_command"], audit),
      ledger, audit, baseMaxSteps: 15,
      entryAgent: "planner",
    };

    const result = await runMultiAgentSession(opts, "crie hello.ts e utils.ts, depois revise");
    expect(result.final).toBe("Aprovado: código limpo e correto.");
    expect(result.steps).toBeLessThan(15);
    expect(result.steps).toBe(7);
    expect(result.agentsUsed).toEqual(["planner", "coder", "reviewer"]);

    // Arquivos criados pelo coder
    expect(readFileSync(join(cwd, "hello.ts"), "utf8")).toContain("hello");
    expect(readFileSync(join(cwd, "utils.ts"), "utf8")).toContain("add");

    // Auditoria: 2 switches
    const events = audit.readAll();
    const switches = events.filter((e) => e.tipo === "agent.switch");
    expect(switches).toHaveLength(2);

    // Ledger: 7 entradas, agents diferentes
    const ledgerEntries = ledger.readAll();
    expect(ledgerEntries).toHaveLength(7);
    const byAgent = ledger.byAgent();
    expect(byAgent.planner.tokensIn).toBe(10); // 1 step
    expect(byAgent.coder.tokensIn).toBe(30);   // 3 steps
    expect(byAgent.reviewer.tokensIn).toBe(30); // 3 steps
  });
});