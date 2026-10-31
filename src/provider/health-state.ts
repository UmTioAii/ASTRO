/**
 * Estado de health/cooldown por provider (M2/A1): alimentado por falhas e
 * sucessos reais do runtime. É uma visão de processo — o CLI é local e o
 * cooldown não sobrevive a um restart, como o cache de credenciais.
 */

const DEFAULT_COOLDOWN_MS = 60_000;
const coolingUntil = new Map<string, number>();
let revision = 0;

/** Providers cujo erro indica indisponibilidade/credencial, não request inválido. */
const HEALTH_FAILURES: ReadonlySet<string> = new Set(["transient_rate_limit", "outage", "network_timeout", "auth"]);

/** Incrementa a revisão (invalida snapshots de candidatos). */
export function bumpHealthRevision(): void {
  revision++;
}

/** Marca falha de health; erros de request não entram em cooldown. */
export function markProviderFailure(
  provider: string,
  errorClass: string,
  opts: { now?: number; cooldownMs?: number } = {},
): void {
  if (!HEALTH_FAILURES.has(errorClass)) return;
  const until = (opts.now ?? Date.now()) + (opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  if ((coolingUntil.get(provider) ?? 0) >= until) return;
  coolingUntil.set(provider, until);
  bumpHealthRevision();
}

/** Limpa o cooldown do provider no primeiro sucesso. */
export function markProviderSuccess(provider: string): void {
  if (coolingUntil.delete(provider)) bumpHealthRevision();
}

/** O provider está em cooldown agora? Remove a entrada vencida. */
export function isProviderCooling(provider: string, now = Date.now()): boolean {
  const until = coolingUntil.get(provider);
  if (until === undefined) return false;
  if (now >= until) {
    coolingUntil.delete(provider);
    bumpHealthRevision();
    return false;
  }
  return true;
}

/** Revisão atual; snapshots comparam para invalidar (A1). */
export function providerHealthRevision(): number {
  return revision;
}

/** Limpa o estado (testes e novo processo). */
export function resetProviderHealth(): void {
  coolingUntil.clear();
  revision = 0;
}
