import { runTask, type RunReport } from "./app";

const USAGE = `Uso:
  bun src/cli.ts run "<pedido>" [--config <path>] [--cwd <dir>]
  bun src/cli.ts --help

Opções:
  --config <path>  configuração do Astro (default: astro.config.json)
  --cwd <dir>      diretório de trabalho do agente (default: diretório atual)
  --help           mostra este texto`;

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

type ParsedCommand = { kind: "help" } | { kind: "run"; options: RunCommand };

function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    throw new UsageError("nenhum argumento informado");
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  const [command, ...rest] = argv;
  if (command !== "run") {
    throw new UsageError(`comando desconhecido: "${command}"`);
  }

  let configPath = "astro.config.json";
  let cwd: string | undefined;
  let task: string | undefined;

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
