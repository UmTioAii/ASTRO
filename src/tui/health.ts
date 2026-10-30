/** Classificação e formatação do health de provider na TUI (#228). */
import type { HealthCheck } from "../health";

export type HealthErrorClass = "auth" | "invalid_request" | "transient_rate_limit" | "outage";

/** Mapeia o detalhe do health para a taxonomia D-14/D-18; `ok` não tem classe. */
export function classifyProviderCheck(check: HealthCheck): HealthErrorClass | undefined {
  if (check.status === "ok") return undefined;
  const detail = check.detail ?? "";
  if (detail.startsWith("defina ") || /ENOENT|EACCES|EPERM/.test(detail)) return "auth";
  const status = /HTTP (\d{3})/.exec(detail)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    if (code === 401 || code === 403) return "auth";
    if (code === 429) return "transient_rate_limit";
    if (code >= 500) return "outage";
    return "invalid_request";
  }
  if (/timeout|abort|Unable to connect|fetch failed/i.test(detail)) return "outage";
  return "outage";
}

/** Linha curta para a tela de providers; nunca inclui credencial. */
export function formatProviderCheck(check: HealthCheck): string {
  const errorClass = classifyProviderCheck(check);
  const latency = check.latencyMs === undefined ? "" : ` · ${check.latencyMs}ms`;
  const detail = check.detail === undefined ? "" : ` · ${check.detail}`;
  return check.status === "ok" ? `ok${latency}` : `down (${errorClass})${latency}${detail}`;
}
