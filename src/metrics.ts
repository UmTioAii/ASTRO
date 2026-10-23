/**
 * Métricas Prometheus (F6-1): contadores em memória alimentados por callback
 * opcional de Auditor/Ledger, expostos em formato texto Prometheus via serve.
 *
 * Métricas: astro_runs_total{agent,status}, astro_tokens_total{provider,model,direction},
 * astro_cost_usd_total{provider,model}, astro_errors_total{provider,model,class},
 * astro_step_duration_seconds_{count,sum}{agent,tool} (média via sum/count).
 */

type Labels = Record<string, string>;

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const parts = entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`);
  return `{${parts.join(",")}}`;
}

interface Bucket {
  value: number;
}

/** Registro de métricas em memória com render em formato Prometheus. */
export class Metrics {
  readonly #counters = new Map<string, Map<string, Bucket>>();
  readonly #help = new Map<string, string>();

  private counterMap(name: string, labels: Labels, help: string): Map<string, Bucket> {
    if (!this.#help.has(name)) this.#help.set(name, help);
    let map = this.#counters.get(name);
    if (map === undefined) {
      map = new Map();
      this.#counters.set(name, map);
    }
    return map;
  }

  private inc(name: string, labels: Labels, delta: number, help: string): void {
    const key = formatLabels(labels);
    const map = this.counterMap(name, labels, help);
    const current = map.get(key) ?? { value: 0 };
    current.value += delta;
    map.set(key, current);
  }

  /** Execuções finalizadas por agent e status (ok | error). */
  incRun(agent: string, status: "ok" | "error"): void {
    this.inc("astro_runs_total", { agent, status }, 1, "Runs finalizados por agent e status.");
  }

  /** Tokens acumulados por provider/modelo e direção (in | out). */
  incTokens(provider: string, model: string, direction: "in" | "out", tokens: number): void {
    this.inc("astro_tokens_total", { provider, model, direction }, tokens, "Tokens acumulados.");
  }

  /** Custo estimado acumulado em USD por provider/modelo. */
  addCost(provider: string, model: string, usd: number): void {
    this.inc("astro_cost_usd_total", { provider, model }, usd, "Custo estimado acumulado em USD.");
  }

  /** Erros classificados por provider/modelo e classe (D-18). */
  incError(provider: string, model: string, errorClass: string): void {
    this.inc("astro_errors_total", { provider, model, class: errorClass }, 1, "Erros classificados.");
  }

  /** Duração de step de tool: acumula soma e contagem para média. */
  observeStep(agent: string, tool: string, seconds: number): void {
    this.inc("astro_step_duration_seconds_sum", { agent, tool }, seconds, "Soma das durações de step (s).");
    this.inc("astro_step_duration_seconds_count", { agent, tool }, 1, "Contagem de steps.");
  }

  /** Render no formato de texto Prometheus (uma linha por série). */
  render(): string {
    const lines: string[] = [];
    const names = [...this.#counters.keys()].sort();
    for (const name of names) {
      const help = this.#help.get(name) ?? "";
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const map = this.#counters.get(name)!;
      const keys = [...map.keys()].sort();
      for (const key of keys) {
        const bucket = map.get(key)!;
        const value = Number(bucket.value.toFixed(6));
        lines.push(`${name}${key} ${value}`);
      }
    }
    return lines.length === 0 ? "" : lines.join("\n") + "\n";
  }
}

/**
 * Coletor: converte eventos de auditoria e entradas de ledger em métricas.
 * Espera os mesmos payloads que Auditor.append e Ledger.record produzem.
 */
export class MetricsCollector {
  readonly #metrics: Metrics;
  readonly #pendingToolCalls = new Map<string, number>(); // tool.call id → ts epoch

  constructor(metrics: Metrics) {
    this.#metrics = metrics;
  }

  /** Callback para Auditor (onEvent): processa eventos de run e tool. */
  readonly onAuditEvent = (event: {
    tipo: string;
    agent?: string;
    payload: Record<string, unknown>;
    ts: string;
  }): void => {
    const agent = event.agent ?? "default";
    switch (event.tipo) {
      case "run.completed":
        this.#metrics.incRun(agent, "ok");
        break;
      case "run.stopped":
        this.#metrics.incRun(agent, "error");
        break;
      case "tool.call": {
        // timestamp do início do step, indexado por seq do evento
        this.#pendingToolCalls.set(`${agent}:${event.payload.name}`, Date.parse(event.ts));
        break;
      }
      case "tool.result": {
        const key = `${agent}:${event.payload.name}`;
        const started = this.#pendingToolCalls.get(key);
        if (started !== undefined) {
          this.#pendingToolCalls.delete(key);
          const seconds = Math.max(0, (Date.now() - started) / 1000);
          this.#metrics.observeStep(agent, String(event.payload.name), seconds);
        }
        break;
      }
      default:
        break;
    }
  };

  /** Callback para Ledger (onRecord): tokens e custo por provider/modelo. */
  readonly onLedgerRecord = (entry: {
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
  }): void => {
    this.#metrics.incTokens(entry.provider, entry.model, "in", entry.tokensIn);
    this.#metrics.incTokens(entry.provider, entry.model, "out", entry.tokensOut);
    if (entry.costUsd !== null) this.#metrics.addCost(entry.provider, entry.model, entry.costUsd);
  };
}

/**
 * Inicia o servidor HTTP que expõe /metrics no formato Prometheus (F6-1).
 * Os contadores acumulam de runs no MESMO processo (runTask com metrics).
 */
export function startMetricsServer(
  metrics: Metrics,
  port: number,
): { url: string; stop: () => void } {
  const server = Bun.serve({
    port,
    fetch(request): Response {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/metrics") {
        return new Response(metrics.render(), {
          headers: { "content-type": "text/plain; version=0.0.4" },
        });
      }
      return new Response("não encontrado", { status: 404 });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}