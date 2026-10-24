/**
 * Health check (F6-6): valida config, credenciais do ambiente e conectividade
 * dos providers (GET /models com timeout por check). Um provider fora não
 * derruba os outros: status agregado ok | degraded | down.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AstroConfig, CodexOAuthProviderConfig, OpenAICompatProviderConfig, ProviderConfig } from "./config";

// Predicates: PluginProviderConfig (kind: string) sobrepõe os literais dos
// built-ins e desativa a discriminação automática da união.
function isOpenAICompat(p: ProviderConfig): p is OpenAICompatProviderConfig {
  return p.kind === "openai-compat";
}

function isCodexOAuth(p: ProviderConfig): p is CodexOAuthProviderConfig {
  return p.kind === "codex-oauth";
}

export type CheckStatus = "ok" | "down";

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
}

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheck[];
}

export interface HealthOptions {
  /** Timeout por check de provider (ms); default 5000. */
  timeoutMs?: number;
  fetchLike?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** GET {baseUrl}/models com header de autenticação e timeout. */
async function checkEndpoint(
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchLike: typeof fetch,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetchLike(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, latencyMs, detail: `HTTP ${response.status} em GET /models` };
    }
    return { ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, latencyMs, detail: detail.includes("abort") ? `timeout de ${timeoutMs}ms` : detail };
  } finally {
    clearTimeout(timeout);
  }
}

/** Roda os checks de health para a config carregada. */
export async function runHealthCheck(
  config: AstroConfig,
  env: Record<string, string | undefined>,
  opts: HealthOptions = {},
): Promise<HealthReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchLike = opts.fetchLike ?? fetch;
  const checks: HealthCheck[] = [];

  // Check 1: config (já carregada com sucesso — registra como ok)
  checks.push({ name: "config", status: "ok", detail: `${Object.keys(config.providers).length} providers` });

  // Checks por provider
  for (const [name, provider] of Object.entries(config.providers)) {
    if (isOpenAICompat(provider)) {
      const credentialRef = provider.credentialRef;
      const apiKey = env[credentialRef];
      if (apiKey === undefined || apiKey.length === 0) {
        checks.push({
          name: `provider:${name}`,
          status: "down",
          detail: `defina ${credentialRef} no ambiente`,
        });
        continue;
      }
      const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
      for (const [h, v] of Object.entries(provider.headers ?? {})) headers[h] = v;
      const result = await checkEndpoint(provider.baseUrl, headers, timeoutMs, fetchLike);
      checks.push({
        name: `provider:${name}`,
        status: result.ok ? "ok" : "down",
        latencyMs: result.latencyMs,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      continue;
    }

    if (isCodexOAuth(provider)) {
      // codex-oauth: arquivo de credenciais legível; conectividade exigiria
      // refresh de token — fora do escopo do health, verifica o essencial
      const credentialsPath = expandHome(provider.credentialsPath);
      try {
        readFileSync(credentialsPath, "utf8");
        checks.push({ name: `provider:${name}`, status: "ok", detail: "credenciais legíveis" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        checks.push({ name: `provider:${name}`, status: "down", detail });
      }
      continue;
    }

    // Kind de plugin (F7-1): sem verificação automática disponível
    checks.push({
      name: `provider:${name}`,
      status: "ok",
      detail: `kind "${provider.kind}" de plugin; sem check automático`,
    });
  }

  const providerChecks = checks.filter((c) => c.name.startsWith("provider:"));
  const downNames = new Set(providerChecks.filter((c) => c.status === "down").map((c) => c.name));
  const missingCredentialNames = new Set(
    providerChecks.filter((c) => c.status === "down" && (c.detail ?? "").startsWith("defina")).map((c) => c.name),
  );

  // Agregação (F6-6): tudo ok → ok; falha mista ou só credencial ausente →
  // degraded (config local, corrigível); todos fora com falha de endpoint → down.
  let status: HealthStatus = "ok";
  if (downNames.size > 0) {
    const anyEndpointFailure = [...downNames].some((n) => !missingCredentialNames.has(n));
    const allDown = downNames.size === providerChecks.length;
    status = allDown && anyEndpointFailure ? "down" : "degraded";
  }

  return { status, checks };
}