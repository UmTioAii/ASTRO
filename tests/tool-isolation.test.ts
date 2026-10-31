import { describe, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { runCommandTool, configureRunCommand } from "../src/tools/run-command";
import type { ToolCall } from "../src/provider/types";
import type { Tool } from "../src/tools/types";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `c-${name}`,
  name,
  arguments: JSON.stringify(args),
});

// Estes testes executam comandos locais de propósito: opt-out explícito do sandbox.
beforeEach(() => configureRunCommand({ sandbox: false }));

/** Cria uma tool simples de teste para registro dinâmico. */
function makeTool(name: string): Tool {
  return {
    manifest: {
      name,
      description: `test tool ${name}`,
      parameters: { type: "object", properties: {} },
      risk: "low",
      permission: "test",
      timeoutMs: 1000,
      retryable: false,
      idempotent: false,
      sideEffects: "none",
    },
    async execute() {
      return { output: `${name}-ok` };
    },
  };
}

describe("isolamento de tools por agent (F3-5)", () => {
  test("tool fora da allowlist do agent → erro com nome do agent + tool.denied no audit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Planner só tem read_file; tenta run_command
    const executor = new ToolExecutor({
      tools: [readFileTool, writeFileTool, runCommandTool],
      allow: ["read_file"], // planner: só read_file
      audit,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      call("run_command", { command: "echo hi" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("run_command");
    expect(result.output).toContain("planner");

    // Auditoria loga tool.denied
    const events = audit.readAll();
    const denied = events.find((e) => e.tipo === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("planner");
    expect(denied!.payload.name).toBe("run_command");
    expect(denied!.payload.reason).toContain("não permitida");
  });

  test("coder com run_command na allowlist → executa ok", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    const executor = new ToolExecutor({
      tools: [readFileTool, writeFileTool, runCommandTool],
      allow: ["read_file", "write_file", "run_command"], // coder: todas
      audit,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "coder" },
      call("run_command", { command: "echo hello" }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("hello");

    // Sem tool.denied no audit
    const events = audit.readAll();
    expect(events.find((e) => e.tipo === "tool.denied")).toBeUndefined();
  });

  test("tool desconhecida também gera tool.denied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    const executor = new ToolExecutor({
      tools: [readFileTool],
      allow: ["read_file"],
      audit,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "reviewer" },
      call("ghost_tool", {}),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("desconhecida");

    const events = audit.readAll();
    const denied = events.find((e) => e.tipo === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.payload.reason).toContain("desconhecida");
  });

  test("planner tenta run_command → erro; coder usa run_command → ok (cenário multi-agent)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Dois executores com allowlists diferentes (como runMultiAgentSession cria)
    const plannerExecutor = new ToolExecutor({
      tools: [readFileTool, writeFileTool, runCommandTool],
      allow: ["read_file"], // planner: só leitura
      audit,
    });
    const coderExecutor = new ToolExecutor({
      tools: [readFileTool, writeFileTool, runCommandTool],
      allow: ["read_file", "write_file", "run_command"], // coder: todas
      audit,
    });

    // Planner tenta run_command → negado
    const plannerResult = await plannerExecutor.run(
      { cwd, run: "r1", agent: "planner" },
      call("run_command", { command: "echo no" }),
    );
    expect(plannerResult.isError).toBe(true);
    expect(plannerResult.output).toContain("planner");

    // Coder usa run_command → ok
    const coderResult = await coderExecutor.run(
      { cwd, run: "r1", agent: "coder" },
      call("run_command", { command: "echo yes" }),
    );
    expect(coderResult.isError).toBeFalsy();
    expect(coderResult.output).toContain("yes");

    // Audit tem tool.denied do planner e tool.result ok do coder
    const events = audit.readAll();
    const deniedEvents = events.filter((e) => e.tipo === "tool.denied");
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0].agent).toBe("planner");
  });
});

describe("regressão do tool guard: registro dinâmico e escopo de subagent (S-04, #121)", () => {
  test("(a) tool registrada DEPOIS do executor criado NÃO executa para o mesmo agent: tool.denied no audit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-dyn-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Tool inicial
    const initialTool = makeTool("initial_tool");

    const executor = new ToolExecutor({
      tools: [initialTool],
      allow: ["initial_tool"],
      audit,
    });

    // Registra uma NOVA tool APÓS criar o executor (simula registro dinâmico)
    const dynamicTool = makeTool("dynamic_tool");
    const executorWithDynamic = new ToolExecutor({
      tools: [...executor.allTools, dynamicTool],
      allow: [...executor.allow, "dynamic_tool"],
      audit,
    });

    // O executor ORIGINAL (que foi criado ANTES do registro dinâmico)
    // NÃO deve executar a tool dinâmica mesmo que ela esteja na allowlist
    // porque o ToolExecutor não a conhece (não estava no byName map no momento da criação)
    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      call("dynamic_tool", {}),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("desconhecida");

    // Auditoria loga tool.denied
    const events = audit.readAll();
    const denied = events.find((e) => e.tipo === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("planner");
    expect(denied!.payload.name).toBe("dynamic_tool");
    expect(denied!.payload.reason).toContain("desconhecida");
  });

  test("(b) tool registrada no executor do subagent fica dentro do allowlist do subagent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sub-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Executor base (orchestrator)
    const baseExecutor = new ToolExecutor({
      tools: [readFileTool, makeTool("parent_only")],
      allow: ["read_file", "parent_only"],
      audit,
    });

    // Subagent tem seu próprio executor com tool exclusiva
    const subExecutor = new ToolExecutor({
      tools: [...baseExecutor.allTools, makeTool("sub_only")],
      allow: ["read_file", "sub_only"],
      audit,
    });

    // Subagent consegue executar sua tool exclusiva
    const subResult = await subExecutor.run(
      { cwd, run: "r1", agent: "subagent" },
      call("sub_only", {}),
    );
    expect(subResult.isError).toBeFalsy();
    expect(subResult.output).toContain("sub_only-ok");

    // Subagent NÃO consegue executar a tool exclusiva do parent (não está no allowlist do sub)
    const parentToolResult = await subExecutor.run(
      { cwd, run: "r1", agent: "subagent" },
      call("parent_only", {}),
    );
    expect(parentToolResult.isError).toBe(true);
    expect(parentToolResult.output).toContain("não permitida");

    // Verifica auditoria: tool.denied para parent_only no subagent
    const events = audit.readAll();
    const denied = events.find(
      (e) => e.tipo === "tool.denied" && e.payload.name === "parent_only",
    );
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("subagent");
  });

  test("(c) subagent pedindo tool fora do teto do parent é negado — escopo nunca maior que o do pai", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-ceil-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Parent tem teto: read_file + write_file
    const parentTools = [readFileTool, writeFileTool];
    const parentAllow = ["read_file", "write_file"];

    const parentExecutor = new ToolExecutor({
      tools: parentTools,
      allow: parentAllow,
      audit,
    });

    // Subagent tenta ter run_command (que NÃO está no teto do parent)
    // O teto do subagent deve ser o allowlist do parent
    const subExecutor = new ToolExecutor({
      tools: [...parentTools, runCommandTool],
      allow: ["read_file", "write_file", "run_command"], // teto maior que o do pai
      ceiling: [...parentExecutor.allow], // mas o teto é o do pai
      audit,
    });

    // Subagent tenta run_command → deve ser negado (escopo maior que o do pai)
    const result = await subExecutor.run(
      { cwd, run: "r1", agent: "subagent" },
      call("run_command", { command: "echo hack" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora do teto de escopo");

    // Auditoria
    const events = audit.readAll();
    const denied = events.find(
      (e) => e.tipo === "tool.denied" && e.payload.name === "run_command",
    );
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("subagent");
  });

  test("(d) tool MCP registrada mid-session sob namespace dinâmico é negada a menos que explicitamente permitida", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-mcp-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Simula tools MCP descobertas mid-session
    const mcpTool = makeTool("mcp__filesystem__read_file");

    // Executor inicial NÃO tem a tool MCP
    const executor = new ToolExecutor({
      tools: [readFileTool],
      allow: ["read_file"],
      audit,
    });

    // Tentativa de chamar a tool MCP antes de estar no executor
    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      call("mcp__filesystem__read_file", { path: "test.txt" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("desconhecida");

    // Auditoria
    const events = audit.readAll();
    const denied = events.find(
      (e) => e.tipo === "tool.denied" && e.payload.name === "mcp__filesystem__read_file",
    );
    expect(denied).toBeDefined();

    // Agora registra a tool MCP explicitamente
    const executorWithMcp = new ToolExecutor({
      tools: [readFileTool, mcpTool],
      allow: ["read_file", "mcp__filesystem__read_file"],
      audit,
    });

    // Agora deve funcionar
    const result2 = await executorWithMcp.run(
      { cwd, run: "r1", agent: "planner" },
      call("mcp__filesystem__read_file", { path: "test.txt" }),
    );
    expect(result2.isError).toBeFalsy();
  });

  test("(e) entryAgent default name 'planner' pinado contra src/config.ts:82-83 (A13, Q-03)", async () => {
    // Teste de configuração: o entryAgent default deve ser "planner"
    // Este teste valida que a constante não muda silenciosamente
    const { validateConfig } = await import("../src/config");

    const config = validateConfig({
      providers: { a: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "K" } },
      models: [{ provider: "a", id: "m", tags: ["writing-code"], context: 8 }],
      agent: { model: "a/m", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    });

    expect(config.agent.entryAgent).toBe("planner");
  });
});