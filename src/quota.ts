/**
 * Rate-limit e quota enforcement (F6-3): limites por quotaDomain checados
 * contra o ledger ANTES de cada chamada ao provider. Estouro lança
 * QuotaExceededError (errClass "hard_quota", taxonomia D-18) — bloqueando
 * o gasto antes que aconteça. O retry de 429/Retry-After vive no provider.
 */
import type { Ledger } from "./ledger";
import { ProviderError } from "./provider/types";

/** Limite de quota por domínio; pelo menos um campo deve existir. */
export interface QuotaLimit {
  dailyTokens?: number;
  monthlyCostUsd?: number;
}

/** Erro de quota excedida; classificado como hard_quota (não retriable). */
export class QuotaExceededError extends ProviderError {
  constructor(message: string) {
    super("hard_quota", message);
    this.name = "QuotaExceededError";
  }
}

interface Usage {
  todayTokens: number;
  monthCostUsd: number;
}

/** Soma uso do domínio: tokens de hoje e custo do mês corrente. */
function usageFor(ledger: Ledger, quotaDomain: string, now: Date): Usage {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const usage: Usage = { todayTokens: 0, monthCostUsd: 0 };

  for (const entry of ledger.readAll()) {
    if (entry.quotaDomain !== quotaDomain) continue;
    if (entry.ts.slice(0, 10) === today) {
      usage.todayTokens += entry.tokensIn + entry.tokensOut;
    }
    if (entry.ts.slice(0, 7) === month) {
      usage.monthCostUsd += entry.costUsd ?? 0;
    }
  }
  return usage;
}

/**
 * Verifica se o domínio ainda tem quota; lança QuotaExceededError quando o
 * uso atual já atingiu o limite (chamadas novas são bloqueadas antes de gastar).
 * Domínio sem limite declarado passa direto.
 */
export function assertWithinQuota(
  ledger: Ledger,
  limits: Record<string, QuotaLimit>,
  quotaDomain: string,
  now: Date = new Date(),
): void {
  const limit = limits[quotaDomain];
  if (limit === undefined) return;

  const usage = usageFor(ledger, quotaDomain, now);
  const reasons: string[] = [];

  if (limit.dailyTokens !== undefined && usage.todayTokens >= limit.dailyTokens) {
    reasons.push(
      `tokens de hoje (${usage.todayTokens}) atingiram o limite diário (${limit.dailyTokens})`,
    );
  }
  if (limit.monthlyCostUsd !== undefined && usage.monthCostUsd >= limit.monthlyCostUsd) {
    reasons.push(
      `custo do mês (US$ ${usage.monthCostUsd.toFixed(4)}) atingiu o limite mensal (US$ ${limit.monthlyCostUsd})`,
    );
  }

  if (reasons.length > 0) {
    throw new QuotaExceededError(
      `quota excedida no domínio "${quotaDomain}": ${reasons.join("; ")}`,
    );
  }
}