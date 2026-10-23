/**
 * Benchmark de providers (F5-4): mede latência, tokens/sec e custo/1k tokens
 * por modelo, com a mesma suite de prompts. TTFT requer streaming, que o
 * contrato Provider ainda não expõe — o campo vai como null (follow-up).
 * Custo só é calculado para modelos com `price.verificado: true`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "../registry";
import type { CompletionRequest, CompletionResponse, Provider } from "../provider/types";

/** Suite padrão de prompts: mesma para todos os modelos. */
const PROMPTS: readonly string[] = [
  "Explique em uma frase o que é uma função pura.",
  "Escreva uma função TypeScript que devolve o maior de dois números.",
  "Liste três vantagens de testes automatizados.",
  "Reescreva: 'o código dele era muito longo' em tom técnico.",
  "Dê um exemplo de erro off-by-one e como evitá-lo.",
];

export interface BenchLatency {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface BenchModelResult {
  model: string;
  provider: string;
  tags: string[];
  runs: number;
  latencyMs: BenchLatency;
  tokensInAvg: number;
  tokensOutAvg: number;
  tokensPerSec: number;
  /** Custo estimado por 1k tokens de saída; null sem preço verificado. */
  costPer1kOutUsd: number | null;
  /** TTFT exige streaming no contrato Provider; null até existir. */
  ttftMs: number | null;
}

export interface BenchReport {
  schema: number;
  date: string;
  prompts: number;
  results: BenchModelResult[];
}

export interface BenchOptions {
  models: ModelEntry[];
  /** Fábrica de provider por modelo (real via config; mock nos testes). */
  providerFor: (model: ModelEntry) => Provider;
  runs?: number;
  outDir?: string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[index]!;
}

/** Executa a suite para um modelo e devolve as métricas agregadas. */
export async function benchModel(
  model: ModelEntry,
  providerFor: BenchOptions["providerFor"],
  runs: number,
): Promise<BenchModelResult> {
  const provider = providerFor(model);
  const latencies: number[] = [];
  let tokensInTotal = 0;
  let tokensOutTotal = 0;

  for (let run = 0; run < runs; run++) {
    for (const prompt of PROMPTS) {
      const req: CompletionRequest = {
        model: model.id,
        messages: [{ role: "user", content: prompt }],
      };
      const started = Date.now();
      const response: CompletionResponse = await provider.complete(req);
      latencies.push(Date.now() - started);
      tokensInTotal += response.usage.inputTokens;
      tokensOutTotal += response.usage.outputTokens;
    }
  }

  const calls = latencies.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const tokensInAvg = calls === 0 ? 0 : tokensInTotal / calls;
  const tokensOutAvg = calls === 0 ? 0 : tokensOutTotal / calls;
  const latencyAvg = calls === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / calls;
  const tokensPerSec = latencyAvg === 0 ? 0 : tokensOutAvg / (latencyAvg / 1000);

  const costPer1kOutUsd =
    model.price !== undefined && model.price.verificado ? model.price.outputPerM : null;

  return {
    model: `${model.provider}/${model.id}`,
    provider: model.provider,
    tags: [...model.tags],
    runs,
    latencyMs: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? 0,
    },
    tokensInAvg: Math.round(tokensInAvg),
    tokensOutAvg: Math.round(tokensOutAvg),
    tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    costPer1kOutUsd,
    ttftMs: null,
  };
}

/** Roda o benchmark para todos os modelos informados. */
export async function runBenchmark(opts: BenchOptions): Promise<BenchReport> {
  const runs = opts.runs ?? 1;
  const results: BenchModelResult[] = [];
  for (const model of opts.models) {
    results.push(await benchModel(model, opts.providerFor, runs));
  }
  const report: BenchReport = {
    schema: 1,
    date: new Date().toISOString().slice(0, 10),
    prompts: PROMPTS.length,
    results,
  };
  if (opts.outDir !== undefined) {
    writeFileSync(
      join(opts.outDir, `bench-${report.date}.json`),
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(join(opts.outDir, `bench-${report.date}.md`), formatMarkdown(report), "utf8");
  }
  return report;
}

function fmtCost(v: number | null): string {
  return v === null ? "n/d" : `US$ ${v.toFixed(4)}`;
}

/** Tabela Markdown do relatório. */
export function formatMarkdown(report: BenchReport): string {
  const lines = [
    `# Benchmark de providers — ${report.date}`,
    "",
    `Prompts por execução: ${report.prompts}. TTFT requer streaming no contrato Provider (pendente).`,
    "",
    "| Modelo | Tags | p50 (ms) | p95 (ms) | tokens out/call | tokens/s | custo/1k out |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    lines.push(
      `| ${r.model} | ${r.tags.join(", ")} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ` +
        `${r.tokensOutAvg} | ${r.tokensPerSec} | ${fmtCost(r.costPer1kOutUsd)} |`,
    );
  }
  return lines.join("\n") + "\n";
}