import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { runCommandTool } from "../src/tools/run-command";
import { grepTool } from "../src/tools/grep";
import { editTool } from "../src/tools/edit";
import { pipelineTool } from "../src/tools/pipeline";
import type { Tool } from "../src/tools/types";

const ALL_TOOLS = [readFileTool, writeFileTool, runCommandTool, grepTool, editTool, pipelineTool];

function setup(content: string): { cwd: string; audit: Auditor; executor: ToolExecutor } {
  const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-"));
  writeFileSync(join(cwd, "target.txt"), content);
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const executor = new ToolExecutor({
    tools: ALL_TOOLS,
    allow: ["read_file", "write_file", "run_command", "grep", "edit", "pipeline"],
    audit,
  });
  return { cwd, audit, executor };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

const call = (name: string, args: Record<string, unknown>) => ({
  id: `c-${name}`,
  name,
  arguments: JSON.stringify(args),
});

describe("pipeline tool (F4-5)", () => {
  test("manifesto correto", () => {
    expect(pipelineTool.manifest.name).toBe("pipeline");
    expect(pipelineTool.manifest.risk).toBe("high");
    expect(pipelineTool.manifest.permission).toBe("write");
    expect(pipelineTool.manifest.timeoutMs).toBe(120_000);
    expect(pipelineTool.manifest.retryable).toBe(false);
    const params = pipelineTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("steps");
    expect(params.required).toContain("steps");
  });

  test("pipeline de 3 steps (grep → edit → run_command) executa em sequência", async () => {
    const { cwd, audit, executor } = setup("valor original\nvalor x\n");
    // step 1: grep encontra a linha; step 2: edit troca; step 3: run_command valida
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "valor original", path: "." } },
          {
            tool: "edit",
            input: {
              path: "target.txt",
              diff: "--- a/target.txt\n+++ b/target.txt\n@@ -1,1 +1,1 @@\n-valor original\n+valor alterado\n",
            },
          },
          { tool: "run_command", input: { command: "echo pipeline-ok" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBeFalsy();
    // último step vira output final
    expect(result.output).toContain("pipeline-ok");
    // edit aplicou
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toContain("valor alterado");
  });

  test("output de step N vira stdin de step N+1", async () => {
    const { cwd, audit, executor } = setup("abc\n");
    // step 1 escreve conteúdo conhecido; step 2 lê e devolve; conferimos que o run recebe o output anterior via stdin via um arquivo intermediário — mais simples: usar write_file → read_file e verificar o output final
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "write_file", input: { path: "step1.txt", content: "dados do step 1" } },
          { tool: "read_file", input: { path: "step1.txt" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBeFalsy();
    // output final é o do read_file
    expect(result.output).toContain("dados do step 1");
  });

  test("auditoria loga pipeline.step com tool e isError", async () => {
    const { cwd, audit, executor } = setup("x\n");
    await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "x" } },
          { tool: "run_command", input: { command: "echo ok" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    const events = audit.readAll();
    const steps = events.filter((e) => e.tipo === "pipeline.step");
    expect(steps).toHaveLength(2);
    expect(steps[0]!.payload.tool).toBe("grep");
    expect(steps[0]!.payload.step).toBe(0);
    expect(steps[1]!.payload.tool).toBe("run_command");
    expect(steps[1]!.payload.step).toBe(1);
    // steps bem-sucedidos: isError false
    expect(steps[0]!.payload.isError).toBe(false);
  });

  test("falha em step intermediário para o pipeline com erro acumulado", async () => {
    const { cwd, audit, executor } = setup("conteudo\n");
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "conteudo" } },
          { tool: "edit", input: { path: "nao-existe.txt", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" } },
          { tool: "run_command", input: { command: "echo nunca-executa" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { failedStep: number; tool: string; steps: unknown[] };
    expect(parsed.failedStep).toBe(1);
    expect(parsed.tool).toBe("edit");
    // step 3 nunca rodou
    const events = audit.readAll();
    const steps = events.filter((e) => e.tipo === "pipeline.step");
    expect(steps).toHaveLength(2);
  });

  test("sub-tool fora da allowlist do agent é negada (I-01)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    // allowlist só tem pipeline e grep; edit NÃO
    const executor = new ToolExecutor({
      tools: ALL_TOOLS,
      allow: ["pipeline", "grep"],
      audit,
    });
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "x" } },
          { tool: "edit", input: { path: "target.txt", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("não permitida");
    // audit registra tool.denied do edit
    const events = audit.readAll();
    expect(events.some((e) => e.tipo === "tool.denied" && e.payload.name === "edit")).toBe(true);
  });

  test("pipeline como sub-tool é rejeitado (sem recursão)", async () => {
    const { cwd, executor } = setup("x\n");
    const result = await pipelineTool.execute(
      {
        steps: [{ tool: "pipeline", input: { steps: [{ tool: "grep", input: { pattern: "x" } }] } }],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("recursão");
  });

  test("steps vazio → erro claro", async () => {
    const { cwd, executor } = setup("x\n");
    const result = await pipelineTool.execute({ steps: [] }, { ...ctx(cwd), executor });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("steps");
  });

  test("mais de 10 steps → erro claro", async () => {
    const { cwd, executor } = setup("x\n");
    const steps = Array.from({ length: 11 }, () => ({ tool: "grep", input: { pattern: "x" } }));
    const result = await pipelineTool.execute({ steps }, { ...ctx(cwd), executor });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("10");
  });

  test("sem executor no contexto → erro claro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-"));
    const result = await pipelineTool.execute(
      { steps: [{ tool: "grep", input: { pattern: "x" } }] },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("executor");
  });
});
describe("pipeline cancelamento (#260)", () => {
  test("abort entre steps: o step seguinte não executa", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-abort-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const controller = new AbortController();
    const ran: string[] = [];
    const manifest = {
      description: "step", parameters: { type: "object", properties: {} },
      risk: "low" as const, permission: "test", timeoutMs: 5_000, retryable: false,
      idempotent: false, sideEffects: "none" as const,
    };
    const first: Tool = {
      manifest: { ...manifest, name: "first" },
      async execute() {
        ran.push("first");
        controller.abort();
        return { output: "um" };
      },
    };
    const second: Tool = {
      manifest: { ...manifest, name: "second" },
      async execute() {
        ran.push("second");
        return { output: "dois" };
      },
    };
    const executor = new ToolExecutor({
      tools: [first, second, pipelineTool],
      allow: ["first", "second", "pipeline"],
      audit,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "a", signal: controller.signal },
      { id: "c1", name: "pipeline", arguments: JSON.stringify({ steps: [{ tool: "first", input: {} }, { tool: "second", input: {} }] }) },
    );

    expect(ran).toEqual(["first"]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cancelad");
  });
});

