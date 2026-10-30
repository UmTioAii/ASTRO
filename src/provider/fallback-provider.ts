/**
 * Fallback entre providers (C6, D-14): tenta a cadeia em ordem de prioridade
 * (menor primeiro; empate mantém a ordem declarada). Só retrya erros
 * `transient_rate_limit`/`outage`; erros duros vão direto ao próximo da
 * cadeia. Esgotada a cadeia, o último erro sobe. O provider que atende é
 * devolvido em `response.provider` — o ledger registra o real, não o wrapper
 * (I-03: mensagens de erro já vêm redigidas do adapter, F2).
 */
import type { Auditor } from "../audit";
import { isAbortError } from "../abort";
import { AccountLockedError } from "../agent-lock";
import { markProviderFailure, markProviderSuccess } from "./health-state";
import { streamStarted } from "./types";
import { SwapDeniedError, type SwapApprover, type SwapRequest } from "../approval";
import { ProviderError, type CompletionRequest, type CompletionResponse, type ErrorClass, type Provider } from "./types";

const RETRYABLE: ReadonlySet<string> = new Set(["transient_rate_limit", "outage"]);
/** Prioridade padrão quando o provider não declara (D-15). */
export const DEFAULT_PRIORITY = 100;

export interface FallbackChainEntry {
  name: string;
  priority: number;
  /** Credencial do provider, usada no lock de destino (A7); ausente em keyless. */
  credentialRef?: string;
  /** Conta exclusiva do provider; usada para validar o sticky do agente (A4). */
  accountRef?: string;
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
  /** Profile dono da cadeia (F-31): atribui os eventos ao profile afetado. */
  profile?: string;
  /** Gate de aprovação (F-19): obrigatório no runtime; ausente = sem gate (componente interno). */
  approveSwap?: SwapApprover;
  /** Move o lock para a conta do provider de destino (A7); lança AccountLockedError se ocupada. */
  moveAccount?: (entry: FallbackChainEntry, reason: ErrorClass) => void;
  /** Conta que o agente corrente detém; valida o sticky entre agentes (A4). */
  currentAccount?: () => string | undefined;
  /** Pré-checagem de conta livre (A7) para não pedir aprovação de destino ocupado. */
  canUseAccount?: (entry: FallbackChainEntry) => boolean;
  /** Nome do agente corrente no multi-agent (atribui swap.* corretamente). */
  agentName?: () => string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FallbackProvider implements Provider {
  readonly #chain: FallbackChainEntry[];
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
  readonly #audit?: Auditor;
  readonly #run?: string;
  readonly #profile?: string;
  readonly #approveSwap?: SwapApprover;
  readonly #moveAccount?: (entry: FallbackChainEntry, reason: ErrorClass) => void;
  readonly #currentAccount?: () => string | undefined;
  readonly #canUseAccount?: (entry: FallbackChainEntry) => boolean;
  readonly #agentName?: () => string;
  /** Provider que atendeu por último nesta execução: não volta ao primário a cada step. */
  #activeProvider: string | undefined;

  constructor(opts: FallbackProviderOptions) {
    this.#chain = [...opts.providers].sort((a, b) => a.priority - b.priority);
    this.#maxRetries = opts.maxRetries ?? 2;
    this.#retryBackoffMs = opts.retryBackoffMs ?? 1_000;
    this.#audit = opts.audit;
    this.#run = opts.run;
    this.#profile = opts.profile;
    this.#approveSwap = opts.approveSwap;
    this.#moveAccount = opts.moveAccount;
    this.#currentAccount = opts.currentAccount;
    this.#canUseAccount = opts.canUseAccount;
    this.#agentName = opts.agentName;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    let lastError: unknown;
    let previous: string | undefined;
    let previousReason: ErrorClass = "invalid_request";
    const stickyIndex = this.#activeProvider === undefined
      ? -1
      : this.#chain.findIndex((entry) => entry.name === this.#activeProvider);
    const currentAccount = this.#currentAccount?.();
    const stickyEntry = stickyIndex > 0 ? this.#chain[stickyIndex] : undefined;
    const stickyMatches = stickyEntry !== undefined &&
      (stickyEntry.accountRef === undefined || currentAccount === undefined || stickyEntry.accountRef === currentAccount);
    const chain = stickyMatches ? this.#chain.slice(stickyIndex) : this.#chain;
    for (const entry of chain) {
      if (previous !== undefined && this.#canUseAccount !== undefined && !this.#canUseAccount(entry)) {
        this.#log("provider.fallback_skipped", {
          provider: entry.name,
          reason: previousReason,
          errorClass: "account_locked",
        });
        continue;
      }
      if (previous !== undefined && this.#approveSwap !== undefined) {
        const request: SwapRequest = {
          run: this.#run ?? "",
          ...(this.#agentName === undefined ? {} : { agent: this.#agentName() }),
          from: { provider: previous, model: req.model },
          to: { provider: entry.name, model: req.model },
          reason: previousReason,
        };
        if (!(await this.#approveSwap(request))) throw new SwapDeniedError(request, "denied");
      }
      if (previous !== undefined && this.#moveAccount !== undefined) {
        try {
          this.#moveAccount(entry, previousReason);
        } catch (error) {
          if (error instanceof AccountLockedError) {
            this.#log("provider.fallback_skipped", {
              provider: entry.name,
              reason: previousReason,
              errorClass: "account_locked",
            });
            continue;
          }
          throw error;
        }
      }
      let provider: Provider;
      try {
        provider = entry.create();
      } catch (error) {
        // Falha de fábrica (ex.: credencial ausente) não aborta a cadeia:
        // vira evento de falha e o próximo provider saudável é tentado
        lastError = error;
        this.#log("provider.failure", { provider: entry.name, errorClass: "invalid_request", attempt: 1 });
        previous = entry.name;
        previousReason = "invalid_request";
        continue;
      }
      let lastClass: ErrorClass = "invalid_request";
      for (let attempt = 1; attempt <= this.#maxRetries + 1; attempt++) {
        const startedAt = Date.now();
        try {
          const response = await provider.complete(req, signal);
          this.#log("provider.success", { provider: entry.name, latencyMs: Date.now() - startedAt, attempt });
          markProviderSuccess(entry.name);
          this.#activeProvider = entry.name;
          return { ...response, provider: entry.name, model: response.model ?? req.model };
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          // Negação de troca é terminal (I-08): não tenta o próximo provider
          if (error instanceof SwapDeniedError) throw error;
          const errorClass = error instanceof ProviderError ? error.errClass : "invalid_request";
          if (streamStarted.has(req)) {
            markProviderFailure(entry.name, errorClass);
            throw error;
          }
          lastError = error;
          lastClass = errorClass;
          this.#log("provider.failure", { provider: entry.name, errorClass, attempt });
          if (!RETRYABLE.has(errorClass) || attempt > this.#maxRetries) break; // próximo da cadeia
          await sleep(this.#retryBackoffMs * attempt);
        }
      }
      markProviderFailure(entry.name, lastClass);
      previous = entry.name;
      previousReason = lastClass;
    }
    throw lastError;
  }

  #log(tipo: "provider.success" | "provider.failure" | "provider.fallback_skipped", payload: Record<string, unknown>): void {
    if (this.#audit === undefined || this.#run === undefined) return;
    this.#audit.append({
      run: this.#run,
      tipo,
      payload: this.#profile === undefined ? payload : { ...payload, profile: this.#profile },
    });
  }
}
