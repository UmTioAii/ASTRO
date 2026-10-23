import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isKnownTag } from "../src/tags";

const GOLDEN_ROOT = join(import.meta.dir, "..", "eval", "golden");
const EXPECTED_CASES = 50;
const CATEGORIES = ["refactor", "bugfix", "testgen", "doc", "feature"] as const;

interface CaseMeta {
  schema: number;
  id: string;
  category: (typeof CATEGORIES)[number];
  difficulty: number;
  tags: string[];
  files: string[];
}

function loadCases(): Array<{ dir: string; meta: CaseMeta }> {
  const entries = readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(GOLDEN_ROOT, e.name))
    .sort();
  return entries.map((dir) => ({
    dir,
    meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as CaseMeta,
  }));
}

describe("golden dataset (F5-1)", () => {
  test("contém exatamente 50 cases", () => {
    const cases = loadCases();
    expect(cases).toHaveLength(EXPECTED_CASES);
  });

  test("cobertura: 10 cases por categoria", () => {
    const cases = loadCases();
    const byCategory = new Map<string, number>();
    for (const c of cases) {
      byCategory.set(c.meta.category, (byCategory.get(c.meta.category) ?? 0) + 1);
    }
    for (const category of CATEGORIES) {
      expect(byCategory.get(category)).toBe(10);
    }
  });

  test("schema meta.json válido em todos os cases", () => {
    for (const c of loadCases()) {
      expect(c.meta.schema).toBe(1);
      expect(c.meta.id).toBeTruthy();
      expect(CATEGORIES).toContain(c.meta.category);
      expect(c.meta.difficulty).toBeGreaterThanOrEqual(1);
      expect(c.meta.difficulty).toBeLessThanOrEqual(3);
      expect(c.meta.tags.length).toBeGreaterThan(0);
      for (const tag of c.meta.tags) {
        expect(isKnownTag(tag)).toBe(true);
      }
    }
  });

  test("task.md existe e não é vazio", () => {
    for (const c of loadCases()) {
      const task = readFileSync(join(c.dir, "task.md"), "utf8");
      expect(task.trim().length).toBeGreaterThan(10);
    }
  });

  test("expected/ contém todos os arquivos declarados em meta.files", () => {
    for (const c of loadCases()) {
      expect(c.meta.files.length).toBeGreaterThan(0);
      for (const file of c.meta.files) {
        expect(existsSync(join(c.dir, "expected", file))).toBe(true);
      }
    }
  });

  test("ids únicos", () => {
    const ids = loadCases().map((c) => c.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});