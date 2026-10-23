/**
 * Auto-eval harness (F5-2): roda os cases do golden dataset por uma sessão real
 * (provider + tools + ledger/audit) e compara os arquivos produzidos com os
 * esperados. Comparação de código .ts é por AST (formato ignorado); texto é
 * normalizado; gera relatório com pass rate e regressões vs baseline.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Auditor } from "../audit";
import { Ledger } from "../ledger";
import type { CompletionResponse, Provider } from "../provider/types";
import type { ModelEntry } from "../registry";
import { runSession } from "../session";
import { ToolExecutor } from "../tools/executor";
import { readFileTool } from "../tools/read-file";
import { writeFileTool } from "../tools/write-file";

const MODEL: ModelEntry = {
  provider: "mock", id: "golden-mock", tags: ["writing-code"], context: 128000, status: "active",
};

export interface GoldenCase {
  dir: string;
  id: string;
  category: string;
  files: string[];
}

export interface CaseResult {
  case: string;
  category: string;
  passed: boolean;
  tokens: number;
  latencyMs: number;
  diffSummary: string[];
}

export interface EvalReport {
  schema: number;
  passRate: number;
  total: number;
  passed: number;
  regressions: string[];
  cases: CaseResult[];
}

export interface EvalOptions {
  goldenRoot: string;
  /** Provider determinístico que escreve os arquivos esperados via write_file. */
  mock?: boolean;
  threshold?: number;
  baselinePath?: string;
  reportPath?: string;
}

/** Lista os cases do golden dataset (ordem alfabética dos diretórios). */
export function listGoldenCases(goldenRoot: string): GoldenCase[] {
  return readdirSync(goldenRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(goldenRoot, e.name))
    .sort()
    .map((dir) => {
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
        id: string; category: string; files: string[];
      };
      return { dir, id: meta.id, category: meta.category, files: meta.files };
    });
}

// --- Comparação ---

function normalizeText(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0).join("\n");
  return norm(a) === norm(b);
}

let tsMod: ClassicTs | null = null;

/** Superfície mínima da API clássica do TypeScript (TS 5.x). TS 7 não a expõe. */
interface ClassicTs {
  createSourceFile(name: string, text: string, target: unknown, setParents: boolean): unknown;
  createPrinter(opts: { newLine: unknown; removeComments: boolean }): { printFile(sf: unknown): string };
  ScriptTarget: Record<string, unknown>;
  NewLineKind: Record<string, unknown>;
}

function isClassicTs(mod: unknown): mod is ClassicTs {
  const record = mod as Record<string, unknown>;
  return typeof record.createSourceFile === "function" && typeof record.createPrinter === "function";
}

async function loadTs(): Promise<ClassicTs | null> {
  if (tsMod !== null) return tsMod;
  try {
    const mod = (await import("typescript")) as unknown as Record<string, unknown>;
    if (isClassicTs(mod)) {
      tsMod = mod;
      return tsMod;
    }
    const candidate = mod.default as Record<string, unknown> | undefined;
    if (candidate !== undefined && isClassicTs(candidate)) {
      tsMod = candidate as ClassicTs;
      return tsMod;
    }
  } catch {
    // typescript indisponível; cai para comparação de texto
  }
  return null;
}

/** Comparação de AST via printer com formatação uniforme; null quando indisponível. */
async function astEqual(a: string, b: string): Promise<boolean | null> {
  const ts = await loadTs();
  if (ts === null) return null;
  const print = (text: string): string => {
    const sf = ts.createSourceFile("f.ts", text, ts.ScriptTarget.ESNext, true);
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
    return printer.printFile(sf).replace(/\s+/g, " ").trim();
  };
  try {
    return print(a) === print(b);
  } catch {
    return null;
  }
}

/** Compara conteúdo produzido vs esperado. */
export async function compareFile(path: string, produced: string, expected: string): Promise<{ equal: boolean; mode: "ast" | "text" }> {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    const ast = await astEqual(produced, expected);
    if (ast !== null) return { equal: ast, mode: "ast" };
  }
  return { equal: normalizeText(produced, expected), mode: "text" };
}

// --- Provider mock: escreve os arquivos esperados numa sequência de tool calls ---

function mockProvider(caseDir: string, files: string[]): Provider {
  let step = 0;
  const writes = files.map((file, i) => {
    const content = readFileSync(join(caseDir, "expected", file), "utf8");
    return { id: `w${i}`, name: "write_file", arguments: JSON.stringify({ path: file, content }) };
  });
  return {
    async complete(): Promise<CompletionResponse> {
      step++;
      if (step === 1) {
        return {
          content: "aplicando resultado esperado",
          toolCalls: writes,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return { content: "concluído", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

// --- Execução de um case ---

export async function runCase(golden: GoldenCase, opts: { mock: boolean }): Promise<CaseResult> {
  const cwd = mkdtempSync(join(tmpdir(), `astro-eval-${randomUUID().slice(0, 8)}-`));
  const started = Date.now();
  try {
    // Semeia o workspace inicial (cases sem arquivos iniciais não têm workspace/)
    const workspaceDir = join(golden.dir, "workspace");
    if (existsSync(workspaceDir)) {
      cpSync(workspaceDir, cwd, { recursive: true });
    }

    const auditPath = join(cwd, ".audit.jsonl");
    const ledgerPath = join(cwd, ".ledger.jsonl");
    const audit = new Auditor(auditPath);
    const ledger = new Ledger(ledgerPath, { warn: () => {} }); // eval não precisa de aviso de preço
    const executor = new ToolExecutor({
      tools: [readFileTool, writeFileTool],
      allow: ["read_file", "write_file"],
      audit,
    });

    // Modo mock (determinístico, sem credenciais): o provider aplica os arquivos
    // esperados via write_file, exercitando o loop real de sessão + tools.
    const provider = mockProvider(golden.dir, golden.files);
    await runSession(
      {
        run: `eval-${golden.id}`, agent: "eval", credentialRef: "MOCK", quotaDomain: "eval",
        cwd, provider, model: MODEL, executor, ledger, audit, maxSteps: 5,
      },
      readFileSync(join(golden.dir, "task.md"), "utf8"),
    );

    const tokens = ledger.readAll().reduce((acc, e) => acc + e.tokensIn + e.tokensOut, 0);

    const diffSummary: string[] = [];
    let passed = true;
    for (const file of golden.files) {
      const producedPath = join(cwd, file);
      if (!existsSync(producedPath)) {
        passed = false;
        diffSummary.push(`${file}: não foi criado`);
        continue;
      }
      const produced = readFileSync(producedPath, "utf8");
      const expected = readFileSync(join(golden.dir, "expected", file), "utf8");
      const cmp = await compareFile(file, produced, expected);
      if (!cmp.equal) {
        passed = false;
        diffSummary.push(`${file}: conteúdo divergente (${cmp.mode})`);
      }
    }
    return { case: golden.id, category: golden.category, passed, tokens, latencyMs: Date.now() - started, diffSummary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      case: golden.id, category: golden.category, passed: false, tokens: 0,
      latencyMs: Date.now() - started, diffSummary: [`erro na execução: ${message}`],
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// --- Baseline ---

interface Baseline {
  schema: number;
  passRate: number;
  cases: Record<string, boolean>;
}

function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

/** Regressões: cases que passavam no baseline e falharam agora. */
function findRegressions(results: CaseResult[], baseline: Baseline | null): string[] {
  if (baseline === null) return [];
  return results.filter((r) => r.passed === false && baseline.cases[r.case] === true).map((r) => r.case);
}

// --- Runner ---

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const cases = listGoldenCases(opts.goldenRoot);
  const results: CaseResult[] = [];
  for (const golden of cases) {
    results.push(await runCase(golden, { mock: opts.mock ?? true }));
  }

  const passed = results.filter((r) => r.passed).length;
  const baseline = opts.baselinePath ? loadBaseline(opts.baselinePath) : null;
  const regressions = findRegressions(results, baseline);

  const report: EvalReport = {
    schema: 1,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    total: cases.length,
    passed,
    regressions,
    cases: results,
  };

  if (opts.reportPath !== undefined) {
    writeFileSync(opts.reportPath, JSON.stringify(report, null, 2), "utf8");
  }
  return report;
}

/** Sai com erro quando o pass rate fica abaixo do threshold. */
export function evalFailsThreshold(report: EvalReport, threshold: number): boolean {
  return report.passRate < threshold || report.regressions.length > 0;
}

/** Gera o arquivo de baseline a partir de um relatório (commitado por PR). */
export function writeBaseline(report: EvalReport, path: string): void {
  const cases: Record<string, boolean> = {};
  for (const c of report.cases) cases[c.case] = c.passed;
  writeFileSync(path, JSON.stringify({ schema: 1, passRate: report.passRate, cases }, null, 2) + "\n", "utf8");
}