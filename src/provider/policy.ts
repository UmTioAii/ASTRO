/**
 * Política de ação por classe de erro (F-01, I-09, D-14/D-18).
 *
 * Função pura: dado o `errClass` e o número da tentativa, devolve a ação que
 * o roteador deve tomar — retry, skip, fallback ou abort. O provider pode
 * ter retry interno (mesmo provider); esta política informa o que o
 * orquestrador faz quando o provider esgota ou decide não retentar.
 */

import type { ErrorClass } from "./types";

/** Ação que o roteador toma diante de um erro classificado. */
export type ErrorAction =
  | "retry_backoff"   // tentar de novo com backoff exponencial
  | "retry_after"     // tentar de novo respeitando Retry-After
  | "skip"            // pular este provider, tentar o próximo
  | "fallback"        // cair para provider/modelo alternativo
  | "abort";          // parar; não adianta tentar de novo

/** Limites configuráveis da política. */
export interface PolicyLimits {
  /** Máximo de retries para rate limit (default 10; D-18: 2–10). */
  maxRateLimitRetries?: number;
  /** Máximo de retries para outage (default 3). */
  maxOutageRetries?: number;
}

export const DEFAULT_LIMITS: Required<PolicyLimits> = {
  maxRateLimitRetries: 10,
  maxOutageRetries: 3,
};

/**
 * Devolve a ação para uma classe de erro numa dada tentativa.
 *
 * - `transient_rate_limit`: `retry_after` até o limite; depois `fallback`
 * - `outage`: `retry_backoff` até o limite; depois `fallback`
 * - `hard_quota`: sempre `skip` (I-09: cota dura nunca é retentada)
 * - `auth`: sempre `abort` (configuração errada não resolve com retry)
 * - `invalid_request`: sempre `abort` (bug no código não resolve com retry)
 */
export function errorPolicy(
  errClass: ErrorClass,
  attempt: number,
  limits?: PolicyLimits,
): ErrorAction {
  const l = { ...DEFAULT_LIMITS, ...limits };

  switch (errClass) {
    case "transient_rate_limit":
      return attempt < l.maxRateLimitRetries ? "retry_after" : "fallback";
    case "outage":
      return attempt < l.maxOutageRetries ? "retry_backoff" : "fallback";
    case "hard_quota":
      return "skip";
    case "auth":
      return "abort";
    case "invalid_request":
      return "abort";
  }
}
