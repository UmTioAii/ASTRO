/**
 * Fallback entre providers (C6, D-14): tenta a cadeia em ordem de prioridade
 * (menor primeiro; empate mantém a ordem declarada). Só retrya erros
 * `transient_rate_limit`/`outage`; erros duros vão direto ao próximo da
 * cadeia. Esgotada a cadeia, o último erro sobe. O provider que atende é
 * devolvido em `response.provider` — o ledger registra o real, não o wrapper
 * (I-03: mensagens de erro já vêm redigidas do adapter, F2).
 */
import type { Auditor } from "../audit";
import { ProviderError, type CompletionRequest, type CompletionResponse, type Provider } from "./types";

const RETRYABLE: ReadonlySet<string> = new Set(["transient_rate_limit", "outage"]);
/** Prioridade padrão quando o provider não declara (D-15). */
export const DEFAULT_PRIORITY = 100;

export interface FallbackChainEntry {
  name: string;
  priority: number;
  /** Fábrica preguiçosa: credenciais só são resolvidas quando o provider entra na cadeia. */
  create: () => Provider;
}

export interface FallbackProviderOptions {
  providers: FallbackChainEntry[];
  /** Retries por provider além da primeira tentativa (default 2). */
  maxRetries?: number;
  /** Base do backoff linear entre retries (default 1000ms). */
  retryBackoffMs?: number;
  audit?: Auditor;
  run?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FallbackProvider implements Provider {
  readonly #chain: FallbackChainEntry[];
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
  readonly #audit?: Auditor;
  readonly #run?: string;

  constructor(opts: FallbackProviderOptions) {
    this.#chain = [...opts.providers].sort((a, b) => a.priority - b.priority);
    this.#maxRetries = opts.maxRetries ?? 2;
    this.#retryBackoffMs = opts.retryBackoffMs ?? 1_000;
    this.#audit = opts.audit;
    this.#run = opts.run;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let lastError: unknown;
    for (const entry of this.#chain) {
      const provider = entry.create();
      for (let attempt = 1; attempt <= this.#maxRetries + 1; attempt++) {
        const startedAt = Date.now();
        try {
          const response = await provider.complete(req);
          this.#log("provider.success", { provider: entry.name, latencyMs: Date.now() - startedAt, attempt });
          return { ...response, provider: entry.name };
        } catch (error) {
          lastError = error;
          const errorClass = error instanceof ProviderError ? error.errClass : "invalid_request";
          this.#log("provider.failure", { provider: entry.name, errorClass, attempt });
          if (!RETRYABLE.has(errorClass) || attempt > this.#maxRetries) break; // próximo da cadeia
          await sleep(this.#retryBackoffMs * attempt);
        }
      }
    }
    throw lastError;
  }

  #log(tipo: "provider.success" | "provider.failure", payload: Record<string, unknown>): void {
    if (this.#audit === undefined || this.#run === undefined) return;
    this.#audit.append({ run: this.#run, tipo, payload });
  }
}
