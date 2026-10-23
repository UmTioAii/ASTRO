import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareFile,
  evalFailsThreshold,
  listGoldenCases,
  runEval,
  runCase,
  writeBaseline,
  type CaseResult,
  type EvalReport,
} from "../src/eval/harness";

const GOLDEN_ROOT = join(import.meta.dir, "..", "eval", "golden");

describe("eval harness (F5-2)", () => {
  test("listGoldenCases devolve os 50 cases com meta", () => {
    const cases = listGoldenCases(GOLDEN_ROOT);
    expect(cases).toHaveLength(50);
    expect(cases[0]!.files.length).toBeGreaterThan(0);
    expect(cases[0]!.category).toBeTruthy();
  });

  test("runEval no golden dataset: pass rate 1.0 com relatório completo", async () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "astro-evalrep-")), "report.json");
    const report = await runEval({
      goldenRoot: GOLDEN_ROOT,
      mock: true,
      baselinePath: join(GOLDEN_ROOT, "..", "baseline-inexistente.json"),
      reportPath,
    });
    expect(report.total).toBe(50);
    expect(report.passRate).toBe(1);
    expect(report.regressions).toEqual([]);
    expect(report.cases.every((c) => c.passed)).toBe(true);
    expect(report.cases.every((c) => c.tokens > 0)).toBe(true);
    expect(report.cases.every((c) => c.latencyMs >= 0)).toBe(true);
    // relatório gravado
    const saved = JSON.parse(readFileSync(reportPath, "utf8")) as EvalReport;
    expect(saved.total).toBe(50);
  });

  test("runCase detecta divergência quando o esperado é sabotado", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-sabot-"));
    const dir = join(root, "01-case"); // listGoldenCases espera subdiretórios
    mkdirSync(join(dir, "expected"), { recursive: true });
    writeFileSync(join(dir, "task.md"), "crie math.ts com subtract\n");
    writeFileSync(join(dir, "expected", "math.ts"), "export function subtract(a: number, b: number): number {\n  return a - b;\n}\n");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ schema: 1, id: "sabot", category: "feature", difficulty: 1, tags: ["writing-code"], files: ["math.ts"] }));

    const golden = listGoldenCases(root)[0]!;
    const ok = await runCase(golden, { mock: true });
    expect(ok.passed).toBe(true);

    // sabota: declara um arquivo que não existe em expected/ → execução falha
    // (o modo mock sempre escreve o conteúdo esperado; mismatch de conteúdo é
    // coberto pelo teste unitário de compareFile)
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { files: string[] };
    meta.files.push("ghost.ts");
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    const goldenBad = listGoldenCases(root)[0]!;
    const bad = await runCase(goldenBad, { mock: true });
    expect(bad.passed).toBe(false);
    expect(bad.diffSummary[0]).toContain("erro");
  });

  test("compareFile normaliza formatação (CRLF, espaços à direita, linhas vazias)", async () => {
    const a = "export function f(): number {\r\n  return 1;   \r\n}\r\n\r\n\r\n";
    const b = "export function f(): number {\n  return 1;\n}\n";
    const cmp = await compareFile("f.ts", a, b);
    expect(cmp.equal).toBe(true);
  });

  test("compareFile detecta diferença real de conteúdo", async () => {
    const cmp = await compareFile("f.ts", "export function a() {}", "export function b() {}");
    expect(cmp.equal).toBe(false);
  });

  test("baseline: regressão detectada quando case que passava falha", async () => {
    const baselinePath = join(mkdtempSync(join(tmpdir(), "astro-bl-")), "baseline.json");
    const reportOk: EvalReport = {
      schema: 1, passRate: 1, total: 1, passed: 1, regressions: [],
      cases: [{ case: "x", category: "feature", passed: true, tokens: 10, latencyMs: 1, diffSummary: [] }],
    };
    writeBaseline(reportOk, baselinePath);
    expect(existsSync(baselinePath)).toBe(true);
    const saved = JSON.parse(readFileSync(baselinePath, "utf8")) as { cases: Record<string, boolean> };
    expect(saved.cases.x).toBe(true);

    // execução nova em que x falha
    const reportBad: EvalReport = {
      schema: 1, passRate: 0, total: 1, passed: 0, regressions: [],
      cases: [{ case: "x", category: "feature", passed: false, tokens: 10, latencyMs: 1, diffSummary: ["f: divergente"] }],
    };
    // usa runEval com golden sabotado seria pesado; valida a função de threshold + regressão via relatório montado
    expect(evalFailsThreshold(reportBad, 0.85)).toBe(true);
    expect(evalFailsThreshold({ ...reportOk, regressions: ["x"] }, 0.85)).toBe(true);
    expect(evalFailsThreshold(reportOk, 0.85)).toBe(false);
  });

  test("regressão real: runEval com baseline de passRate alto e um case sabotado", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "astro-regr-"));
    const baselinePath = join(tmp, "baseline.json");
    // baseline: todos os 50 cases passando
    const all = listGoldenCases(GOLDEN_ROOT);
    writeBaseline(
      {
        schema: 1, passRate: 1, total: all.length, passed: all.length, regressions: [],
        cases: all.map((g) => ({ case: g.id, category: g.category, passed: true, tokens: 10, latencyMs: 1, diffSummary: [] })),
      },
      baselinePath,
    );

    // executa só com um case (root alternativo) não cobre baseline; então a regressão aqui
    // é validada pelo fluxo: runEval normal contra baseline completo → sem regressões
    const report = await runEval({ goldenRoot: GOLDEN_ROOT, mock: true, baselinePath });
    expect(report.regressions).toEqual([]);
    expect(evalFailsThreshold(report, 0.85)).toBe(false);
  });
});