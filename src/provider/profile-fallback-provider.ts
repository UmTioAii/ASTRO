/** Fallback por profile (F-31, ADR-0007): reusa a política F-01/D-14; ordem declarada, sem repetir profile. */
import type { Auditor } from "../audit";
import { DEFAULT_LIMITS, errorPolicy } from "./policy";
import { ProviderError, type CompletionRequest, type CompletionResponse, type ErrorClass, type FallbackRecord, type Provider } from "./types";

export interface ProfileChainEntry {
  name: string;
  model: string;
  provider: string;
  fallback: string[];
  create: () => Provider;
}

export interface ProfileFallbackProviderOptions {
  base: Provider;
  profiles: ProfileChainEntry[];
  audit?: Auditor;
  run?: string;
}

const EXHAUSTED_ATTEMPT = Math.max(DEFAULT_LIMITS.maxRateLimitRetries, DEFAULT_LIMITS.maxOutageRetries) + 1;

export class ProfileFallbackProvider implements Provider {
  readonly #base: Provider;
  readonly #profiles: Map<string, ProfileChainEntry>;
  readonly #audit?: Auditor;
  readonly #run?: string;

  constructor(opts: ProfileFallbackProviderOptions) {
    this.#base = opts.base;
    this.#profiles = new Map(opts.profiles.map((entry) => [entry.name, entry]));
    this.#audit = opts.audit;
    this.#run = opts.run;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const requested = req.profile;
    if (requested === undefined) return this.#base.complete(req);
    const start = this.#profiles.get(requested);
    if (start === undefined) {
      throw new ProviderError("invalid_request", `profile "${requested}" não declarado na modelPool; verifique "agent.profile"`);
    }

    const chain = this.#flatten(start);
    const fallbacks: FallbackRecord[] = [];
    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]!;
      let provider: Provider;
      try {
        provider = entry.create();
      } catch (error) {
        // Fábrica quebrada (ex.: credencial ausente) segue o padrão do C6: tenta o próximo.
        lastError = error;
        this.#log("profile.failure", { profile: entry.name, provider: entry.provider, errorClass: "invalid_request" });
        this.#hop(fallbacks, chain, i, "invalid_request");
        continue;
      }
      try {
        const response = await provider.complete({ ...req, model: entry.model });
        return { ...response, provider: response.provider ?? entry.provider, ...(fallbacks.length === 0 ? {} : { fallbacks }) };
      } catch (error) {
        lastError = error;
        const errorClass: ErrorClass = error instanceof ProviderError ? error.errClass : "invalid_request";
        this.#log("profile.failure", { profile: entry.name, provider: entry.provider, errorClass });
        // Erro não classificado vem da fábrica/config (C6); a política abortaria
        // `invalid_request`, mas aqui ele é pulado como no C6.
        if (error instanceof ProviderError && errorPolicy(errorClass, EXHAUSTED_ATTEMPT) === "abort") throw error;
        this.#hop(fallbacks, chain, i, errorClass);
      }
    }
    throw lastError;
  }

  /** Registra a troca para o próximo profile, quando existe. */
  #hop(fallbacks: FallbackRecord[], chain: ProfileChainEntry[], index: number, reason: ErrorClass): void {
    const from = chain[index]!;
    const to = chain[index + 1];
    if (to === undefined) return;
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

  #log(tipo: "profile.failure" | "profile.fallback", payload: Record<string, unknown>): void {
    if (this.#audit === undefined || this.#run === undefined) return;
    this.#audit.append({ run: this.#run, tipo, payload });
  }
}
