/**
 * Budget (F-05, B1–B10): status derivado do ledger — sem segundo contador.
 * Escopos day/month/project integram quota/team pelo limite mais restritivo;
 * use-as-you-go só registra/exibe (B2) e preço ausente é "n/d", nunca zero (B6).
 */
import type { BudgetConfig } from "./config";
import type { Ledger } from "./ledger";

export interface BudgetStatus {
  scope: BudgetConfig["scope"];
  limitUsd: number | null;
  /** null quando alguma entrada de uso não tem preço (B6). */
  spentUsd: number | null;
  ratio: number | null;
  warnAt: number;
  warning: boolean;
  exhausted: boolean;
  ceilingHit: boolean;
  remainingUsd: number | null;
  /** Estimativa pronta para exibição; "n/d" quando o preço é desconhecido. */
  estimate: string;
}

/** Formata custo sem transformar desconhecido em zero (B6). */
export function formatBudgetEstimate(spentUsd: number | null): string {
  return spentUsd === null ? "n/d" : `US$ ${spentUsd.toFixed(6)}`;
}

/** Aplica o limite mais restritivo entre budget e quota/team (ADR-0013). */
export function restrictBudget(budget: BudgetConfig, extraLimits: Array<number | null | undefined>): BudgetConfig {
  const candidates = extraLimits.filter((value): value is number => value !== null && value !== undefined);
  if (budget.limitUsd === null) {
    return candidates.length === 0 ? budget : { ...budget, limitUsd: Math.min(...candidates) };
  }
  return { ...budget, limitUsd: Math.min(budget.limitUsd, ...candidates) };
}

/** Entrada pertence à janela do escopo (UTC, determinístico). */
function inScope(ts: string, scope: BudgetConfig["scope"], now: Date): boolean {
  // `project` usa a mesma janela mensal do `team.projectBudgetUsd` (ADR-0013).
  if (scope === "use-as-you-go") return true;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return false;
  const sameMonth = at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth();
  return scope === "day" ? sameMonth && at.getUTCDate() === now.getUTCDate() : sameMonth;
}

/** Calcula o status do budget a partir do ledger (fonte única de custo). */
export function budgetStatus(budget: BudgetConfig, ledger: Ledger, now: Date = new Date()): BudgetStatus {
  const entries = ledger.readAll().filter((entry) => inScope(entry.ts, budget.scope, now));
  const spentUsd = entries.some((entry) => entry.costUsd === null)
    ? null
    : entries.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
  const limitUsd = budget.limitUsd;
  const ratio = spentUsd !== null && limitUsd !== null && limitUsd > 0 ? spentUsd / limitUsd : null;
  const exhausted = limitUsd !== null && spentUsd !== null && spentUsd >= limitUsd;
  const ceilingHit = budget.hardCeilingUsd !== undefined && spentUsd !== null && spentUsd >= budget.hardCeilingUsd;
  return {
    scope: budget.scope,
    limitUsd,
    spentUsd,
    ratio,
    warnAt: budget.warnAt,
    warning: (ratio !== null && ratio >= budget.warnAt) || exhausted,
    exhausted,
    ceilingHit,
    remainingUsd: limitUsd !== null && spentUsd !== null ? Math.max(0, limitUsd - spentUsd) : null,
    estimate: formatBudgetEstimate(spentUsd),
  };
}

/** Payload auditável do aviso (B3), sem preço ausente virar zero. */
export function budgetWarningPayload(status: BudgetStatus): Record<string, unknown> {
  return {
    scope: status.scope,
    spentUsd: status.spentUsd,
    limitUsd: status.limitUsd,
    warnAt: status.warnAt,
  };
}
