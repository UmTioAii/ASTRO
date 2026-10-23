import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { runCommandTool } from "../src/tools/run-command";
import type { ToolCall } from "../src/provider/types";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `c-${name}`,
  name,
  arguments: JSON.stringify(args),
});

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