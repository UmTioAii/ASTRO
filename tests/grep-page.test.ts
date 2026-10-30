import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../src/tools/grep";

interface Page {
  results: Array<{ file: string; line: number; match: string }>;
  total: number;
  page: number;
  hasMore: boolean;
}

function manyMatches(count: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-grep-page-"));
  mkdirSync(join(cwd, "many"), { recursive: true });
  for (let index = 0; index < count; index++) {
    writeFileSync(join(cwd, "many", `f${String(index).padStart(3, "0")}.txt`), `needle ${index}\n`);
  }
  return cwd;
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

describe("grep paginado (S-16, CMP-12)", () => {
  test("sem page devolve a primeira página no contrato {results,total,page,hasMore}", async () => {
    const cwd = manyMatches(150);
    const result = await grepTool.execute({ pattern: "needle" }, ctx(cwd));
    const page = JSON.parse(result.output) as Page;

    expect(result.isError).toBeFalsy();
    expect(page.page).toBe(1);
    expect(page.results).toHaveLength(100);
    expect(page.total).toBe(150);
    expect(page.hasMore).toBe(true);
    expect(page.results[0]).toHaveProperty("file");
    expect(page.results[0]).toHaveProperty("line");
    expect(page.results[0]).toHaveProperty("match");
  });

  test("page 2 devolve o restante e marca hasMore=false", async () => {
    const cwd = manyMatches(150);
    const result = await grepTool.execute({ pattern: "needle", page: 2 }, ctx(cwd));
    const page = JSON.parse(result.output) as Page;

    expect(page.page).toBe(2);
    expect(page.results).toHaveLength(50);
    expect(page.total).toBe(150);
    expect(page.hasMore).toBe(false);
  });

  test("página além do total devolve lista vazia, total preservado", async () => {
    const cwd = manyMatches(5);
    const result = await grepTool.execute({ pattern: "needle", page: 3 }, ctx(cwd));
    const page = JSON.parse(result.output) as Page;

    expect(page.results).toEqual([]);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
  });

  test("page inválido falha", async () => {
    const cwd = manyMatches(1);
    for (const page of [0, -1, 1.5]) {
      const result = await grepTool.execute({ pattern: "needle", page }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("page");
    }
  });

  test("sem resultados devolve página vazia com total 0", async () => {
    const cwd = manyMatches(3);
    const result = await grepTool.execute({ pattern: "inexistente" }, ctx(cwd));
    expect(JSON.parse(result.output)).toEqual({ results: [], total: 0, page: 1, hasMore: false });
  });
});
