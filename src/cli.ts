import { runTask, type RunReport, createProvider } from "./app";
import { loadConfig } from "./config";
import { Registry } from "./registry";
import { evalFailsThreshold, runEval, writeBaseline, type EvalReport } from "./eval/harness";
import { runBenchmark, type BenchReport } from "./eval/bench";
import { resolve } from "node:path";

const USAGE = `Uso:
  bun src/cli.ts run "<pedido>" [--config <path>] [--cwd <dir>]
  bun src/cli.ts eval [--threshold <0..1>] [--golden <dir>] [--report <path>] [--baseline <path>] [--write-baseline]
  bun src/cli.ts bench [--config <path>] [--models <filtro>] [--runs <n>] [--out <dir>]
  bun src/cli.ts --help

Opções:
  --config <path>  configuração do Astro (default: astro.config.json)
  --cwd <dir>      diretório de trabalho do agente (default: diretório atual)
  --help           mostra este texto

Eval:
  --threshold <0..1>   mínimo de pass rate (default: 0.85)
  --golden <dir>       diretório do golden dataset (default: eval/golden)
  --report <path>      escreve o relatório JSON no caminho
  --baseline <path>    baseline para detecção de regressões (default: eval/baseline.json)
  --write-baseline     grava baseline a partir desta execução

Bench:
  --models <filtro>    filtra modelos por substring (vírgula separa vários)
  --runs <n>           repetições da suite (default: 1)
  --out <dir>          diretório dos relatórios (default: eval)`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface RunCommand {
  task: string;
  configPath: string;
  cwd?: string;
}

interface EvalCommand {
  threshold: number;
  goldenRoot: string;
  reportPath?: string;
  baselinePath: string;
  writeBaseline: boolean;
}

interface BenchCommand {
  configPath: string;
  models?: string;
  runs: number;
  outDir: string;
}

type ParsedCommand =
  | { kind: "help" }
  | { kind: "run"; options: RunCommand }
  | { kind: "eval"; options: EvalCommand }
  | { kind: "bench"; options: BenchCommand };

function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    throw new UsageError("nenhum argumento informado");
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  const [command, ...rest] = argv;
  if (command !== "run" && command !== "eval" && command !== "bench") {
    throw new UsageError(`comando desconhecido: "${command}"`);
  }

  if (command === "bench") {
    let configPath = "astro.config.json";
    let models: string | undefined;
    let runs = 1;
    let outDir = "eval";
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--config" || arg === "--models" || arg === "--runs" || arg === "--out") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`falta o valor de ${arg}`);
        }
        i++;
        if (arg === "--config") configPath = value;
        else if (arg === "--models") models = value;
        else if (arg === "--runs") {
          runs = Number(value);
          if (!Number.isInteger(runs) || runs < 1) {
            throw new UsageError(`--runs deve ser inteiro >= 1 (recebido: ${value})`);
          }
        } else outDir = value;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    return {
      kind: "bench",
      options: { configPath, ...(models === undefined ? {} : { models }), runs, outDir },
    };
  }

  let configPath = "astro.config.json";
  let cwd: string | undefined;
  let task: string | undefined;

  if (command === "eval") {
    let threshold = 0.85;
    let goldenRoot = "eval/golden";
    let reportPath: string | undefined;
    let baselinePath = "eval/baseline.json";
    let writeBaselineFlag = false;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--threshold" || arg === "--golden" || arg === "--report" || arg === "--baseline") {
        const value = rest.at(i + 1);
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`falta o valor de ${arg}`);
        }
        i++;
        if (arg === "--threshold") {
          threshold = Number(value);
          if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
            throw new UsageError(`--threshold deve ser entre 0 e 1 (recebido: ${value})`);
          }
        } else if (arg === "--golden") {
          goldenRoot = value;
        } else if (arg === "--report") {
          reportPath = value;
        } else {
          baselinePath = value;
        }
        continue;
      }
      if (arg === "--write-baseline") {
        writeBaselineFlag = true;
        continue;
      }
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }
    return {
      kind: "eval",
      options: { threshold, goldenRoot, ...(reportPath === undefined ? {} : { reportPath }), baselinePath, writeBaseline: writeBaselineFlag },
    };
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;

    if (arg === "--config" || arg === "--cwd") {
      const value = rest.at(i + 1);
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`falta o valor de ${arg}`);
      }
      i++;
      if (arg === "--config") {
        configPath = value;
      } else {
        cwd = value;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`opção desconhecida: "${arg}"`);
    }

    if (task !== undefined) {
      throw new UsageError(`argumento inesperado: "${arg}"`);
    }
    task = arg;
  }

  if (task === undefined) {
    throw new UsageError('falta o pedido; use: run "<pedido>"');
  }

  return { kind: "run", options: { task, configPath, ...(cwd === undefined ? {} : { cwd }) } };
}

function formatCost(costUsd: number | null): string {
  return costUsd === null ? "n/d (sem preço curado)" : `US$ ${costUsd.toFixed(6)}`;
}

/** Uma linha com modelo, tokens, custo e os caminhos de ledger/auditoria. */
function formatSummary(report: RunReport): string {
  return [
    report.model,
    `${report.tokensIn} tokens in / ${report.tokensOut} out`,
    `custo ${formatCost(report.costUsd)}`,
    `ledger ${report.ledgerPath}`,
    `auditoria ${report.auditPath}`,
  ].join(" · ");
}

/** Resumo legível do eval no stdout. */
function formatEval(report: EvalReport): string {
  const lines = [
    `eval: ${report.passed}/${report.total} passaram · pass rate ${(report.passRate * 100).toFixed(1)}%`,
  ];
  if (report.regressions.length > 0) {
    lines.push(`regressões vs baseline: ${report.regressions.join(", ")}`);
  }
  for (const c of report.cases.filter((r) => !r.passed)) {
    lines.push(`  ✗ ${c.case}: ${c.diffSummary.join("; ")}`);
  }
  return lines.join("\n");
}

/** Tabela compacta de bench no stdout. */
function formatBenchTable(report: BenchReport): string {
  const lines = report.results.map(
    (r) =>
      `${r.model} · p50 ${r.latencyMs.p50}ms · ${r.tokensPerSec} tok/s · custo/1k out ` +
      `${r.costPer1kOutUsd === null ? "n/d" : `US$ ${r.costPer1kOutUsd.toFixed(4)}`}`,
  );
  return [`bench: ${report.results.length} modelos · ${report.prompts} prompts`, ...lines].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`erro: ${error.message}\n`);
    console.error(USAGE);
    return 1;
  }

  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }

  if (parsed.kind === "eval") {
    const o = parsed.options;
    const report = await runEval({
      goldenRoot: resolve(o.goldenRoot),
      mock: true,
      threshold: o.threshold,
      baselinePath: resolve(o.baselinePath),
      ...(o.reportPath === undefined ? {} : { reportPath: resolve(o.reportPath) }),
    });
    console.log(formatEval(report));
    if (o.writeBaseline) {
      writeBaseline(report, resolve(o.baselinePath));
      console.log(`baseline gravada em ${o.baselinePath}`);
    }
    if (evalFailsThreshold(report, o.threshold)) {
      console.error(`erro: pass rate abaixo do threshold ${o.threshold} ou regressões detectadas`);
      return 1;
    }
    return 0;
  }

  if (parsed.kind === "bench") {
    const o = parsed.options;
    const config = loadConfig(resolve(o.configPath));
    const registry = new Registry(config);
    const all = registry.list();
    const models = o.models === undefined
      ? all
      : all.filter((m) => o.models!.split(",").some((f) => `${m.provider}/${m.id}`.includes(f.trim())));
    if (models.length === 0) {
      console.error("erro: nenhum modelo ativo corresponde ao filtro");
      return 1;
    }
    const report = await runBenchmark({
      models,
      runs: o.runs,
      outDir: resolve(o.outDir),
      providerFor: (m) => createProvider(config, m, process.env).provider,
    });
    console.log(formatBenchTable(report));
    console.log(`relatórios gravados em ${o.outDir}/bench-${report.date}.{md,json}`);
    return 0;
  }

  try {
    const report = await runTask(parsed.options);
    console.log(report.final);
    console.log("");
    console.log(formatSummary(report));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`erro: ${message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));