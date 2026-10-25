/**
 * Team features (F7-5): budget por projeto, quota por agent e webhook de
 * auditoria. O orçamento e as quotas somam o LEDGER inteiro (todos os
 * domínios) no mês/dia corrente; o webhook repassa cada AuditEvent em
 * fire-and-forget com retry.
 */
import type { Ledger } from "./ledger";
import type { AuditEvent } from "./audit";
import { ProviderError } from "./provider/types";
import { redactSecrets } from "./sanitize-external";

/** Erro de orçamento/quota de time; hard_quota, com sugestão de renovação. */
export class TeamQuotaError extends ProviderError {
  constructor(message: string) {
    super("hard_quota", message);
    this.name = "TeamQuotaError";
  }
}

/** Configuração de time (F7-5). */
export interface TeamConfig {
  /** Orçamento mensal do projeto em USD (soma todos os domínios). */
  projectBudgetUsd?: number;
  /** Quota por agent (tokens/dia e custo/mês do agent, todos os domínios). */
  agentQuotas?: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>;
  /** Webhook que recebe cada AuditEvent (POST JSON, retry 3x). */
  auditWebhook?: string;
}

/** Mês corrente em ISO (yyyy-mm) para janelas do ledger. */
function monthOf(ts: string): string {
  return ts.slice(0, 7);
}
function dayOf(ts: string): string {
  return ts.slice(0, 10);
}

/** Verifica o orçamento mensal do projeto contra o ledger inteiro. */
export function assertProjectBudget(
  ledger: Ledger,
  projectBudgetUsd: number,
  now: Date = new Date(),
): void {
  const month = now.toISOString().slice(0, 7);
  let monthCost = 0;
  for (const entry of ledger.readAll()) {
    if (monthOf(entry.ts) === month) monthCost += entry.costUsd ?? 0;
  }
  if (monthCost >= projectBudgetUsd) {
    throw new TeamQuotaError(
      `orçamento mensal do projeto atingido: US$ ${monthCost.toFixed(4)} de ` +
        `US$ ${projectBudgetUsd}; renove o orçamento no registry ` +
        `(astro config pull) ou aumente team.projectBudgetUsd`,
    );
  }
}

/** Verifica a quota de um agent (tokens de hoje + custo do mês). */
export function assertAgentQuota(
  ledger: Ledger,
  agentQuotas: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>,
  agent: string,
  now: Date = new Date(),
): void {
  const safeAgent = redactSecrets(agent), quota = agentQuotas[agent] ?? agentQuotas[safeAgent];
  if (quota === undefined) return;

  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  let todayTokens = 0;
  let monthCost = 0;
  for (const entry of ledger.readAll()) {
    if (entry.agent !== safeAgent) continue;
    if (dayOf(entry.ts) === today) todayTokens += entry.tokensIn + entry.tokensOut;
    if (monthOf(entry.ts) === month) monthCost += entry.costUsd ?? 0;
  }

  const reasons: string[] = [];
  if (quota.dailyTokens !== undefined && todayTokens >= quota.dailyTokens) {
    reasons.push(`tokens de hoje (${todayTokens}) atingiram a quota do agent (${quota.dailyTokens})`);
  }
  if (quota.monthlyCostUsd !== undefined && monthCost >= quota.monthlyCostUsd) {
    reasons.push(
      `custo do mês (US$ ${monthCost.toFixed(4)}) atingiu a quota do agent (US$ ${quota.monthlyCostUsd})`,
    );
  }
  if (reasons.length > 0) {
    throw new TeamQuotaError(`quota do agent "${safeAgent}" excedida: ${reasons.join("; ")}`);
  }
}

/**
 * Envia um AuditEvent ao webhook (POST JSON) com até 3 tentativas.
 * Fire-and-forget: falha silenciosa — auditoria local já gravou o evento.
 */
export async function sendAuditWebhook(
  url: string,
  event: AuditEvent,
  opts: { fetchLike?: typeof fetch; retries?: number; backoffMs?: number } = {},
): Promise<boolean> {
  const fetchLike = opts.fetchLike ?? fetch;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 50;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchLike(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (response.ok) return true;
    } catch {
      // rede fora: tenta de novo
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return false;
}