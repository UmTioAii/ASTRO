/**
 * Custo máximo de uma chamada para reserva B9: provider primário + fallbacks
 * declarados e, com profile, a cadeia transitiva de profiles. É a mesma conta
 * usada pelo runtime e pelo filtro de candidatos (S-09), para não divergirem.
 */
import type { AstroConfig } from "./config";
import type { ModelEntry, Registry } from "./registry";

export interface CallCost {
  /** Custo máximo em USD; 0 quando nenhum elo tem preço. */
  usd: number;
  /** false quando algum elo da cadeia não tem preço curado (B6/M6). */
  complete: boolean;
}

function priceFor(registry: Registry, provider: string, model: ModelEntry): ModelEntry["price"] {
  return registry.get(`${provider}/${model.id}`)?.price ?? model.price;
}

/** Custo de um modelo na cadeia de providers; `complete` reflete preço ausente. */
export function chainCost(config: AstroConfig, registry: Registry, model: ModelEntry, provider = model.provider): CallCost {
  const chain = [provider, ...(config.providers[provider]?.fallback ?? [])];
  let usd = 0;
  let complete = true;
  for (const name of chain) {
    const price = priceFor(registry, name, model);
    if (price === undefined) {
      complete = false;
      continue;
    }
    usd += (model.context * Math.max(price.inputPerM, price.outputPerM)) / 1e6;
  }
  return { usd, complete };
}

/** Custo transitivo da cadeia de profiles (fallback de profile), sem repetir. */
export function profileChainCost(
  config: AstroConfig,
  registry: Registry,
  name: string,
  visited = new Set<string>(),
): CallCost {
  if (visited.has(name)) return { usd: 0, complete: true };
  visited.add(name);
  const profile = config.modelPool?.[name];
  if (profile === undefined) return { usd: 0, complete: true };
  const model = registry.resolveProfile(name);
  const own = chainCost(config, registry, model, model.provider);
  let usd = own.usd;
  let complete = own.complete;
  for (const next of profile.fallback ?? []) {
    const fallback = profileChainCost(config, registry, next, visited);
    usd += fallback.usd;
    complete = complete && fallback.complete;
  }
  return { usd, complete };
}

/** Custo máximo da chamada: profile (quando houver) ou modelo direto. */
export function callCost(
  config: AstroConfig,
  registry: Registry,
  model: ModelEntry,
  profile?: string,
): CallCost {
  return profile !== undefined && config.modelPool?.[profile] !== undefined
    ? profileChainCost(config, registry, profile)
    : chainCost(config, registry, model);
}

/** Reserva B9 arredondada para o número usado pelo budget. */
export function reserveForCall(
  config: AstroConfig,
  registry: Registry,
  model: ModelEntry,
  profile?: string,
): number {
  return callCost(config, registry, model, profile).usd;
}
