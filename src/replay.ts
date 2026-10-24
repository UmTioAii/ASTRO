/**
 * Replay / time-travel (F6-5): relê as métricas de um run no log de auditoria
 * (run.completed: steps, tokens, custo) e re-executa a MESMA tarefa com a
 * mesma config, comparando os números. O texto da tarefa não é persistido
 * (só taskHash — D-11), então o replay recebe a tarefa de volta como
 * argumento; o diff é sobre métricas e resposta final.
 */
import { Auditor } from "./audit";
import { runTask } from "./app";

/** Métricas do run original, extraídas do evento run.completed. */
export interface OriginalRunMetrics {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** Extrai as métricas de um run do log de auditoria; null se o run não existe. */
export function findRunMetrics(auditPath: string, runId: string): OriginalRunMetrics | null {
  const audit = new Auditor(auditPath);
  const completed = audit
    .readAll()
    .find((event) => event.run === runId && event.tipo === "run.completed");
  if (completed === undefined) return null;

  const p = completed.payload as {
    steps?: unknown;
    tokensIn?: unknown;
    tokensOut?: unknown;
    costUsd?: unknown;
  };
  return {
    steps: Number(p.steps ?? 0),
    tokensIn: Number(p.tokensIn ?? 0),
    tokensOut: Number(p.tokensOut ?? 0),
    costUsd:
      p.costUsd === null || p.costUsd === undefined || typeof p.costUsd !== "number"
        ? null
        : p.costUsd,
  };
}

export interface ReplayMetrics {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  final: string;
}

export interface ReplayResult {
  runId: string;
  original: OriginalRunMetrics;
  replay: ReplayMetrics;
  /** Métricas e custo idênticos ao run original. */
  identical: boolean;
}

export interface ReplayOptions {
  configPath: string;
  auditPath: string;
  runId: string;
  task: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** Re-executa a tarefa do run e compara com as métricas originais. */
export async function replayRun(opts: ReplayOptions): Promise<ReplayResult> {
  const original = findRunMetrics(opts.auditPath, opts.runId);
  if (original === null) {
    throw new Error(`run "${opts.runId}" não encontrado na auditoria em "${opts.auditPath}"`);
  }

  const report = await runTask({
    configPath: opts.configPath,
    task: opts.task,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });

  const costMatches =
    original.costUsd === null
      ? report.costUsd === null
      : report.costUsd !== null && Math.abs(original.costUsd - report.costUsd) < 1e-9;

  const identical =
    original.steps === report.steps &&
    original.tokensIn === report.tokensIn &&
    original.tokensOut === report.tokensOut &&
    costMatches;

  return {
    runId: opts.runId,
    original,
    replay: {
      steps: report.steps,
      tokensIn: report.tokensIn,
      tokensOut: report.tokensOut,
      costUsd: report.costUsd,
      final: report.final,
    },
    identical,
  };
}