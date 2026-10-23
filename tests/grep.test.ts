import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../src/tools/grep";

function setupWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "astro-grep-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "src", "hello.ts"), "export function hello() {\n  return 'hello';\n}\n");
  writeFileSync(join(cwd, "src", "world.ts"), "export function world() {\n  return 'world';\n}\n");
  writeFileSync(join(cwd, "docs", "readme.md"), "# Hello World\nSome text with hello inside.\n");
  writeFileSync(join(cwd, "empty.txt"), "nothing here\n");
  return cwd;
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

describe("grep tool (F4-1)", () => {
  test("manifesto correto", () => {
    expect(grepTool.manifest.name).toBe("grep");
    expect(grepTool.manifest.risk).toBe("low");
    expect(grepTool.manifest.permission).toBe("read");
    expect(grepTool.manifest.timeoutMs).toBe(30_000);
    expect(grepTool.manifest.retryable).toBe(true);
    const params = grepTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("pattern");
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("flags");
    expect(params.required).toContain("pattern");
  });

  test("encontra padrão em múltiplos arquivos", async () => {
    const cwd = setupWorkspace();
    const result = await grepTool.execute({ pattern: "hello" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const matches = JSON.parse(result.output) as Array<{ file: string; line: number; match: string }>;
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.some((m) => m.file.includes("hello.ts"))).toBe(true);
    expect(matches.some((m) => m.file.includes("readme.md"))).toBe(true);
  });

  test("case-insensitive por default (flag -i)", async () => {
    const cwd = setupWorkspace();
    const result = await grepTool.execute({ pattern: "HELLO" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const matches = JSON.parse(result.output) as Array<{ file: string; line: number; match: string }>;
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("case-sensitive quando flags não tem -i", async () => {
    const cwd = setupWorkspace();
    const result = await grepTool.execute({ pattern: "HELLO", flags: "" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const matches = JSON.parse(result.output) as Array<{ file: string; line: number; match: string }>;
    expect(matches).toHaveLength(0);
  });

  test("limita a 100 resultados", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-grep-"));
    mkdirSync(join(cwd, "many"), { recursive: true });
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(cwd, "many", `f${i}.txt`), `needle in file ${i}\n`);
    }
    const result = await grepTool.execute({ pattern: "needle" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const matches = JSON.parse(result.output) as unknown[];
    expect(matches).toHaveLength(100);
  });

  test("path relativo restringe busca", async () => {
    const cwd = setupWorkspace();
    const result = await grepTool.execute({ pattern: "hello", path: "src" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const matches = JSON.parse(result.output) as Array<{ file: string; line: number; match: string }>;
    expect(matches.every((m) => m.file.includes(join(cwd, "src")))).toBe(true);
    expect(matches.some((m) => m.file.includes("readme.md"))).toBe(false);
  });

  test("caminho fora do cwd → erro (I-11)", async () => {
    const cwd = setupWorkspace();
    const result = await grepTool.execute({ pattern: "hello", path: "../" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });

  test("padrão inválido → erro claro", async () => {
    const cwd = setupWorkspace();
    const result = await grepTool.execute({ pattern: "[invalid" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("regex");
  });

  test("10k arquivos em < 500ms", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-grep-perf-"));
    mkdirSync(join(cwd, "big"), { recursive: true });
    // 1000 arquivos x 10 linhas cada = busca rápida
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(cwd, "big", `f${i}.txt`), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
    }
    const start = Date.now();
    const result = await grepTool.execute({ pattern: "line5" }, ctx(cwd));
    const elapsed = Date.now() - start;
    expect(result.isError).toBeFalsy();
    expect(elapsed).toBeLessThan(500);
    const matches = JSON.parse(result.output) as unknown[];
    expect(matches).toHaveLength(100); // limitado a 100
  });
});