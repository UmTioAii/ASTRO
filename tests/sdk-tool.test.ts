import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError, createMockTool, defineTool, validateManifest, toolFailure, toolSuccess, type ToolManifest } from "../src/sdk/tool";
import { sqlTool } from "../examples/tool-sql/sql";

const validManifest: ToolManifest = {
  name: "x", description: "d", parameters: { type: "object" },
  risk: "low", permission: "read", timeoutMs: 1000, retryable: true,
};

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

describe("tool SDK (F7-3)", () => {
  test("validateManifest aceita manifesto completo (I-12)", () => {
    expect(validateManifest(validManifest)).toEqual(validManifest);
  });

  test("validateManifest rejeita cada campo inválido com mensagem clara", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "" }, /name/],
      [{ description: "" }, /description/],
      [{ parameters: null }, /parameters/],
      [{ risk: "extreme" }, /risk/],
      [{ permission: " " }, /permission/],
      [{ timeoutMs: 0 }, /timeoutMs/],
      [{ timeoutMs: 1.5 }, /timeoutMs/],
      [{ retryable: "yes" }, /retryable/],
    ];
    for (const [override, pattern] of cases) {
      const bad: unknown = { ...validManifest, ...override };
      expect(() => validateManifest(bad)).toThrow(pattern);
    }
  });

  test("defineTool valida manifesto no momento da definição (falha cedo)", async () => {
    expect(() => defineTool({ ...validManifest, risk: "x" }, async () => toolFailure("n"))).toThrow(ToolError);
    const tool = defineTool(validManifest, async () => ({ output: "ok" }));
    expect(tool.manifest.name).toBe("x");
    expect((await tool.execute({}, ctx("."))).output).toBe("ok");
  });

  test("createMockTool registra chamadas e injeta execute", async () => {
    const tool = createMockTool(validManifest, async (input, ctx2) => ({ output: `exec:${JSON.stringify(input)}:${ctx2.agent}` }));
    const r1 = await tool.execute({ a: 1 }, ctx("/tmp"));
    expect(r1.output).toContain('"a":1');
    expect(r1.output).toContain("coder");
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]!.input).toEqual({ a: 1 });
  });

  test("toolFailure/toolSuccess helpers seguem o contrato ToolResult", () => {
    expect(toolFailure("x")).toEqual({ output: "x", isError: true });
    expect(toolSuccess("y")).toEqual({ output: "y" });
  });
});

describe("exemplo tool-sql (F7-3)", () => {
  function setup(): string {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sql-"));
    writeFileSync(
      join(cwd, "dados.json"),
      JSON.stringify([
        { nome: "ana", idade: 30 },
        { nome: "bia", idade: 40 },
        { nome: "caio", idade: 30 },
      ]),
      "utf8",
    );
    return cwd;
  }

  test("consulta com where e limit funciona contra o JSON", async () => {
    const cwd = setup();
    const result = await sqlTool.execute(
      { file: "dados.json", where: { column: "idade", equals: 30 }, limit: 1 },
      ctx(cwd),
    );
    expect(result.isError).toBeFalsy();
    const rows = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ nome: "ana", idade: 30 }]);
  });

  test("sem where devolve tudo (respeitando limit default 100)", async () => {
    const cwd = setup();
    const result = await sqlTool.execute({ file: "dados.json" }, ctx(cwd));
    expect((JSON.parse(result.output) as unknown[]).length).toBe(3);
  });

  test("caminho fora do cwd → erro de confinamento (I-11)", async () => {
    const cwd = setup();
    const result = await sqlTool.execute({ file: "../dados.json" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });

  test("arquivo inexistente ou não-JSON → erro como ToolResult (sem throw)", async () => {
    const cwd = setup();
    const missing = await sqlTool.execute({ file: "fantasma.json" }, ctx(cwd));
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("fantasma.json");

    writeFileSync(join(cwd, "ruim.json"), "não sou json", "utf8");
    const bad = await sqlTool.execute({ file: "ruim.json" }, ctx(cwd));
    expect(bad.isError).toBe(true);
  });
});