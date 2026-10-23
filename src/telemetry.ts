/**
 * Telemetria opt-in (F5-5): envia métricas anônimas de cada run para um
 * endpoint configurável. Off por default; falha de envio nunca derruba o run.
 * Sem PII: nenhum prompt, caminho ou conteúdo de arquivo.
 */
import type { TelemetryConfig } from "./config";

/** Payload enviado por run; campos estritamente métricos. */
export interface TelemetryPayload {
  runId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  steps: number;
  costUsd: number | null;
  errorClass?: string;
}

/** Devolve true quando este run deve ser amostrado. */
export function shouldSample(config: TelemetryConfig): boolean {
  if (!config.enabled) return false;
  if (config.sampleRate >= 1) return true;
  if (config.sampleRate <= 0) return false;
  return Math.random() < config.sampleRate;
}

/** Envia o payload; erros são engolidos (telemetria nunca quebra o run). */
export async function sendTelemetry(
  config: TelemetryConfig,
  payload: TelemetryPayload,
  fetchLike: typeof fetch = fetch,
): Promise<boolean> {
  if (!shouldSample(config)) return false;
  try {
    const response = await fetchLike(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}