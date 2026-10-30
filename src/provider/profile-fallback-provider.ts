/** Fallback por profile (F-31, ADR-0007): reusa a política F-01/D-14; ordem declarada, sem repetir profile. */
import type { Auditor } from "../audit";
import { isAbortError } from "../abort";
import { AccountLockedError } from "../agent-lock";
import { streamStarted } from "./types";
import { SwapDeniedError, type SwapApprover, type SwapRequest } from "../approval";
import { DEFAULT_LIMITS, errorPolicy } from "./policy";
import { ProviderError, type CompletionRequest, type CompletionResponse, type ErrorClass, type FallbackRecord, type Provider } from "./types";

export interface ProfileChainEntry {
  name: string;
  model: string;
  provider: string;
  fallback: string[];
  /** Credencial do profile (nome/caminho/kind), usada no lock de destino (A7). */
  credentialRef?: string;
  create: () => Provider;
}

export interface ProfileFallbackProviderOptions {
  base: Provider;
  profiles: ProfileChainEntry[];
  audit?: Auditor;
  run?: string;
  /** Gate de aprovação (F-19): obrigatório no runtime; ausente = sem gate (componente interno). */
  approveSwap?: SwapApprover;
  /** Move o lock da conta para o profile de destino (A7); lança AccountLockedError se ocupada. */
  moveAccount?: (entry: ProfileChainEntry, reason: ErrorClass) => void;
  /** Nome do agente corrente no multi-agent (atribui swap.* corretamente). */
  agentName?: () => string;
}

const EXHAUSTED_ATTEMPT = Math.max(DEFAULT_LIMITS.maxRateLimitRetries, DEFAULT_LIMITS.maxOutageRetries) + 1;

export class ProfileFallbackProvider implements Provider {
  readonly #base: Provider;
  readonly #profiles: Map<string, ProfileChainEntry>;
  readonly #audit?: Auditor;
  readonly #run?: string;
  readonly #approveSwap?: SwapApprover;
  readonly #moveAccount?: (entry: ProfileChainEntry, reason: ErrorClass) => void;
  readonly #agentName?: () => string;

  constructor(opts: ProfileFallbackProviderOptions) {
    this.#base = opts.base;
    this.#profiles = new Map(opts.profiles.map((entry) => [entry.name, entry]));
    this.#audit = opts.audit;
    this.#run = opts.run;
    this.#approveSwap = opts.approveSwap;
    this.#moveAccount = opts.moveAccount;
    this.#agentName = opts.agentName;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const requested = req.profile;
    if (requested === undefined) return this.#base.complete(req, signal);
    const start = this.#profiles.get(requested);
    if (start === undefined) {
      throw new ProviderError("invalid_request", `profile "${requested}" não declarado na modelPool; verifique "agent.profile"`);
    }

    const chain = this.#flatten(start);
    const fallbacks: FallbackRecord[] = [];
    let lastError: unknown;
    let lastReason: ErrorClass = "invalid_request";
    /** Último profile efetivamente tentado (destinos ocupados não contam). */
    let previousIndex = -1;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]!;
      if (previousIndex >= 0) {
        const fromEntry = chain[previousIndex]!;
        if (this.#approveSwap !== undefined) {
          const request: SwapRequest = {
            run: this.#run ?? "",
            ...(this.#agentName === undefined ? {} : { agent: this.#agentName() }),
            from: { provider: fromEntry.provider, model: fromEntry.model, profile: fromEntry.name },
            to: { provider: entry.provider, model: entry.model, profile: entry.name },
            reason: lastReason,
          };
          if (!(await this.#approveSwap(request))) throw new SwapDeniedError(request, "denied");
        }
        // A7: destino precisa de conta livre; ocupado é pulado sem tentar.
        if (this.#moveAccount !== undefined) {
          try {
            this.#moveAccount(entry, lastReason);
          } catch (error) {
            if (error instanceof AccountLockedError) {
              this.#log("profile.fallback_skipped", {
                profile: entry.name,
                provider: entry.provider,
                reason: lastReason,
                errorClass: "account_locked",
              });
              continue;
            }
            throw error;
          }
        }
        this.#hop(fallbacks, fromEntry, entry, lastReason);
      }
      previousIndex = i;

      let provider: Provider;
      try {
        provider = entry.create();
      } catch (error) {
        // Fábrica quebrada (ex.: credencial ausente) segue o padrão do C6: tenta o próximo.
        lastError = error;
        lastReason = "invalid_request";
        this.#log("profile.failure", { profile: entry.name, provider: entry.provider, errorClass: "invalid_request" });
        continue;
      }
      let attempt: CompletionRequest | undefined;
      try {
        attempt = { ...req, model: entry.model };
        const response = await provider.complete(attempt, signal);
        return { ...response, provider: response.provider ?? entry.provider, model: response.model ?? entry.model, ...(fallbacks.length === 0 ? {} : { fallbacks }) };
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        // Negação de troca é terminal (I-08): não vira hop para o próximo profile
        if (error instanceof SwapDeniedError) throw error;
        if (streamStarted.has(req) || (attempt !== undefined && streamStarted.has(attempt))) throw error;
        lastError = error;
        const errorClass: ErrorClass = error instanceof ProviderError ? error.errClass : "invalid_request";
        lastReason = errorClass;
        this.#log("profile.failure", { profile: entry.name, provider: entry.provider, errorClass });
        // Erro não classificado vem da fábrica/config (C6); a política abortaria
        // `invalid_request`, mas aqui ele é pulado como no C6.
        if (error instanceof ProviderError && errorPolicy(errorClass, EXHAUSTED_ATTEMPT) === "abort") throw error;
      }
    }
    throw lastError;
  }

  /** Registra a troca para o próximo profile, quando existe. */
  #hop(fallbacks: FallbackRecord[], from: ProfileChainEntry, to: ProfileChainEntry, reason: ErrorClass): void {
    const record: FallbackRecord = { profile: from.name, from_provider: from.provider, to_provider: to.provider, reason };
    fallbacks.push(record);
    this.#log("profile.fallback", { ...record });
  }

  /** Ordem declarada, profundidade primeiro, sem repetir profile (I-06). */
  #flatten(start: ProfileChainEntry): ProfileChainEntry[] {
    const out: ProfileChainEntry[] = [];
    const seen = new Set<string>();
    const visit = (entry: ProfileChainEntry): void => {
      if (seen.has(entry.name)) return;
      seen.add(entry.name);
      out.push(entry);
      for (const target of entry.fallback) {
        const next = this.#profiles.get(target);
        if (next !== undefined) visit(next);
      }
    };
    visit(start);
    return out;
  }

  #log(tipo: "profile.failure" | "profile.fallback" | "profile.fallback_skipped", payload: Record<string, unknown>): void {
    if (this.#audit === undefined || this.#run === undefined) return;
    this.#audit.append({ run: this.#run, tipo, payload });
  }
}
