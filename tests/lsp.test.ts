import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspTool, closeLspSessions } from "../src/tools/lsp";

afterEach(() => {
  closeLspSessions();
});

const UTILS = `export function add(a: number, b: number): number {
  return a + b;
}
`;
const MAIN = `import { add } from "./utils";
export function main(): number {
  return add(1, 2);
}
`;

function setupWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-lsp-"));
  writeFileSync(join(cwd, "utils.ts"), UTILS);
  writeFileSync(join(cwd, "main.ts"), MAIN);
  return cwd;
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

interface Location {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

describe("lsp tool (F4-4)", () => {
  test("manifesto correto", () => {
    expect(lspTool.manifest.name).toBe("lsp");
    expect(lspTool.manifest.risk).toBe("low");
    expect(lspTool.manifest.permission).toBe("read");
    expect(lspTool.manifest.timeoutMs).toBe(15_000);
    expect(lspTool.manifest.retryable).toBe(true);
    const params = lspTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("command");
    expect(params.properties).toHaveProperty("file");
    expect(params.properties).toHaveProperty("line");
    expect(params.properties).toHaveProperty("column");
    expect(params.required).toContain("command");
    expect(params.required).toContain("file");
    expect(params.required).toContain("line");
    expect(params.required).toContain("column");
  });

  test("definition: navega para definição de função em outro arquivo", async () => {
    const cwd = setupWorkspace();
    // `add` usado no import de main.ts: linha 1, coluna 10
    const result = await lspTool.execute(
      { command: "definition", file: "main.ts", line: 1, column: 10 },
      ctx(cwd),
    );
    expect(result.isError).toBeFalsy();
    const locations = JSON.parse(result.output) as Location[];
    expect(locations.length).toBeGreaterThanOrEqual(1);
    const target = locations.find((l) => l.file.endsWith("utils.ts"));
    expect(target).toBeDefined();
    expect(target!.file).toContain(cwd);
  });

  test("definition: uso no corpo do código também resolve", async () => {
    const cwd = setupWorkspace();
    // `add(` na linha 3, coluna 10
    const result = await lspTool.execute(
      { command: "definition", file: "main.ts", line: 3, column: 10 },
      ctx(cwd),
    );
    expect(result.isError).toBeFalsy();
    const locations = JSON.parse(result.output) as Location[];
    expect(locations.some((l) => l.file.endsWith("utils.ts"))).toBe(true);
  });

  test("references: encontra referências da função declarada", async () => {
    const cwd = setupWorkspace();
    // declaração de `add` em utils.ts: linha 1, coluna 17
    const result = await lspTool.execute(
      { command: "references", file: "utils.ts", line: 1, column: 17 },
      ctx(cwd),
    );
    expect(result.isError).toBeFalsy();
    const locations = JSON.parse(result.output) as Location[];
    // inclui a declaração (utils.ts) e usos (main.ts)
    expect(locations.some((l) => l.file.endsWith("utils.ts"))).toBe(true);
    expect(locations.some((l) => l.file.endsWith("main.ts"))).toBe(true);
  });

  test("hover: devolve informações de tipo em markdown", async () => {
    const cwd = setupWorkspace();
    const result = await lspTool.execute(
      { command: "hover", file: "utils.ts", line: 1, column: 17 },
      ctx(cwd),
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("add");
    expect(result.output.toLowerCase()).toContain("function");
  });

  test("hover em posição vazia → resultado vazio claro", async () => {
    const cwd = setupWorkspace();
    // linha 2, coluna 3: `return a + b;` — hover em espaço em branco/keyword
    const result = await lspTool.execute(
      { command: "hover", file: "utils.ts", line: 2, column: 1 },
      ctx(cwd),
    );
    // pode ter hover (keyword) ou não; não deve ser erro
    expect(result.isError).toBeFalsy();
  });

  test("comando inválido → erro claro", async () => {
    const cwd = setupWorkspace();
    const result = await lspTool.execute(
      { command: "rename", file: "utils.ts", line: 1, column: 17 } as never,
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command");
  });

  test("arquivo inexistente → erro claro", async () => {
    const cwd = setupWorkspace();
    const result = await lspTool.execute(
      { command: "definition", file: "ghost.ts", line: 1, column: 1 },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("não existe");
  });

  test("caminho fora do cwd → erro (I-11)", async () => {
    const cwd = setupWorkspace();
    const result = await lspTool.execute(
      { command: "definition", file: "../utils.ts", line: 1, column: 1 },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });
});