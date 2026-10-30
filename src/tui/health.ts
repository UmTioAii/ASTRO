/** Classificação e formatação do health de provider na TUI (#228). */
import type { HealthCheck, HealthReport } from "../health";
import type { ErrorClass } from "../provider/types";
import { redactSecrets } from "../sanitize-external";

/** Qualquer classe da taxonomia D-14/D-18, inclusive `hard_quota`. */
export type HealthErrorClass = ErrorClass;

/** Mapeia o detalhe do health para a taxonomia de erro; `ok` não tem classe. */
export function classifyProviderCheck(check: HealthCheck): HealthErrorClass | undefined {
  if (check.status === "ok") return undefined;
  const detail = check.detail ?? "";
  if (detail.startsWith("defina ") || /ENOENT|EACCES|EPERM/.test(detail)) return "auth";
  if (/^authorization:|bearer\s+\S/i.test(detail)) return "auth";
  const status = /HTTP (\d{3})/.exec(detail)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    if (code === 401 || code === 403) return "auth";
    if (code === 402 || (code === 429 && detail.includes("insufficient_quota"))) return "hard_quota";
    if (code === 429) return "transient_rate_limit";
    if (code >= 500) return "outage";
    return "invalid_request";
  }
  if (/timeout|abort|Unable to connect|fetch failed/i.test(detail)) return "outage";
  return "outage";
}

/** Linha curta para a tela de providers; nunca inclui credencial. */
export function formatProviderCheck(check: HealthCheck): string {
  const detail = check.detail?.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
  if (detail !== undefined && detail.includes("sem check automático")) return "n/d (sem check)";
  const errorClass = classifyProviderCheck(check);
  const latency = check.latencyMs === undefined ? "" : ` · ${check.latencyMs}ms`;
  const shown = detail === undefined ? "" : ` · ${redactSecrets(detail)}`;
  return check.status === "ok" ? `ok${latency}` : `down (${errorClass})${latency}${shown}`;
}

/** Estado do provider ativo para a status bar; plugin sem check é `n/d`, nunca `ok`. */
export function providerHealth(report: HealthReport, provider: string): "ok" | "down" | undefined {
  const check = report.checks.find((item) => item.name === `provider:${provider}`);
  if (check === undefined || (check.detail ?? "").includes("sem check automático")) return undefined;
  return check.status === "ok" ? "ok" : "down";
}
