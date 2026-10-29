/**
 * Health check (F6-6): valida config, credenciais do ambiente e conectividade
 * dos providers (GET /models com timeout por check). Um provider fora não
 * derruba os outros: status agregado ok | degraded | down.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, type AstroConfig, type CodexOAuthProviderConfig, type OpenAICompatProviderConfig, type ProviderConfig } from "./config";
import { DEFAULT_PRIORITY } from "./provider/fallback-provider";
import { Registry } from "./registry";

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
  /** Prioridade na cadeia de fallback (C6); default 100 (D-15). */
  priority?: number;
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
      const apiKey = credentialRef === undefined ? undefined : env[credentialRef];
      if (credentialRef !== undefined && (apiKey === undefined || apiKey.length === 0)) {
        checks.push({
          name: `provider:${name}`,
          status: "down",
          priority: provider.priority ?? DEFAULT_PRIORITY,
          detail: `defina ${credentialRef} no ambiente`,
        });
        continue;
      }
      const headers: Record<string, string> = {};
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
      for (const [h, v] of Object.entries(provider.headers ?? {})) headers[h] = v;
      const result = await checkEndpoint(provider.baseUrl, headers, timeoutMs, fetchLike);
      checks.push({
        name: `provider:${name}`,
        status: result.ok ? "ok" : "down",
        latencyMs: result.latencyMs,
        priority: provider.priority ?? DEFAULT_PRIORITY,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      continue;
    }

    if (isCodexOAuth(provider)) {
      // codex-oauth: arquivo de credenciais legível; conectividade exigiria
      // refresh de token - fora do escopo do health, verifica o essencial
      const credentialsPath = expandHome(provider.credentialsPath);
      try {
        readFileSync(credentialsPath, "utf8");
        checks.push({ name: `provider:${name}`, status: "ok", priority: provider.priority ?? DEFAULT_PRIORITY, detail: "credenciais legíveis" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        checks.push({ name: `provider:${name}`, status: "down", priority: provider.priority ?? DEFAULT_PRIORITY, detail });
      }
      continue;
    }

    // Kind de plugin (F7-1): sem verificação automática disponível
    checks.push({
      name: `provider:${name}`,
      status: "ok",
      priority: provider.priority ?? DEFAULT_PRIORITY,
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

/** Lista de providers com prioridade e cadeia de fallback (C6): visão de gerenciamento. */
export function formatProvidersList(config: AstroConfig): string {
  const names = Object.keys(config.providers);
  if (names.length === 0) return 'nenhum provider declarado em "providers"';
  const lines = names.map((name) => {
    const provider = config.providers[name]!;
    const fallback = provider.fallback === undefined || provider.fallback.length === 0 ? "—" : provider.fallback.join(" → ");
    return `${name} · ${provider.kind} · prioridade ${provider.priority ?? DEFAULT_PRIORITY} · fallback ${fallback} · quota ${provider.quotaDomain ?? "default"}`;
  });
  return ["provider · kind · prioridade · fallback · quota", ...lines].join("\n");
}

/**
 * Teste real mínimo de um provider (C6): 1 chamada com a credencial
 * (openai-compat) ou leitura do arquivo (codex-oauth); devolve o HealthCheck
 * do alvo. Provider fora da config → ConfigError em português.
 */
export async function testProvider(
  config: AstroConfig,
  name: string,
  env: Record<string, string | undefined>,
  opts: HealthOptions = {},
): Promise<HealthCheck> {
  const provider = config.providers[name];
  if (provider === undefined) {
    throw new ConfigError(`provider "${name}" não declarado na configuração`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchLike = opts.fetchLike ?? fetch;
  if (isOpenAICompat(provider)) {
    const credentialRef = provider.credentialRef;
    const apiKey = credentialRef === undefined ? undefined : env[credentialRef];
    if (credentialRef !== undefined && (apiKey === undefined || apiKey.length === 0)) {
      return { name: `provider:${name}`, status: "down", priority: provider.priority ?? DEFAULT_PRIORITY, detail: `defina ${credentialRef} no ambiente` };
    }
    const headers: Record<string, string> = {};
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
    for (const [h, v] of Object.entries(provider.headers ?? {})) headers[h] = v;
    const result = await checkEndpoint(provider.baseUrl, headers, timeoutMs, fetchLike);
    return {
      name: `provider:${name}`, status: result.ok ? "ok" : "down", latencyMs: result.latencyMs, priority: provider.priority ?? DEFAULT_PRIORITY,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
  }
  if (isCodexOAuth(provider)) {
    try {
      readFileSync(expandHome(provider.credentialsPath), "utf8");
      return { name: `provider:${name}`, status: "ok", priority: provider.priority ?? DEFAULT_PRIORITY, detail: "credenciais legíveis" };
    } catch (error) {
      return { name: `provider:${name}`, status: "down", priority: provider.priority ?? DEFAULT_PRIORITY, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { name: `provider:${name}`, status: "ok", priority: provider.priority ?? DEFAULT_PRIORITY, detail: `kind "${provider.kind}" de plugin; sem check automático` };
}

/** Status de health de um profile da model pool (F-31). */
export interface ProfileHealthCheck {
  name: string;
  model: string;
  provider: string;
  fallback: string[];
  status: HealthStatus;
  detail?: string;
}

/** Relatório do `pool health` (F-31): providers (F6-6) + status por profile. */
export interface PoolHealthReport {
  status: HealthStatus;
  profiles: ProfileHealthCheck[];
  providers: HealthReport;
}

/**
 * `astro pool health` (F-31): estende o health de providers (F6-6) com status
 * por profile. Um profile é `degraded` quando o provider primário está fora
 * mas a cadeia de fallback tem ao menos um profile saudável; é `down` quando
 * nenhum caminho da cadeia responde.
 */
export async function runPoolHealthCheck(
  config: AstroConfig,
  env: Record<string, string | undefined>,
  opts: HealthOptions = {},
): Promise<PoolHealthReport> {
  const providers = await runHealthCheck(config, env, opts);
  const pool = config.modelPool ?? {};
  const names = Object.keys(pool);
  if (names.length === 0) {
    return { status: providers.status, profiles: [], providers };
  }

  const registry = new Registry(config);
  const providerStatus = new Map(providers.checks.map((c) => [c.name, c.status]));
  const memo = new Map<string, ProfileHealthCheck>();
  const visiting = new Set<string>();

  const resolve = (name: string): ProfileHealthCheck => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const profile = pool[name];
    if (profile === undefined) {
      const missing: ProfileHealthCheck = { name, model: "?", provider: "?", fallback: [], status: "down", detail: "profile não declarado" };
      memo.set(name, missing);
      return missing;
    }
    const model = registry.resolveProfile(name);
    const fallback = profile.fallback ?? [];
    const base = { name, model: `${model.provider}/${model.id}`, provider: model.provider, fallback };
    const own = providerStatus.get(`provider:${model.provider}`) === "ok";
    let result: ProfileHealthCheck;
    if (own) {
      result = { ...base, status: "ok" };
    } else if (visiting.has(name)) {
      result = { ...base, status: "down", detail: "ciclo de fallback" };
    } else {
      visiting.add(name);
      const healthy = fallback.filter((target) => resolve(target).status !== "down");
      visiting.delete(name);
      result = healthy.length > 0
        ? { ...base, status: "degraded", detail: `provider fora; fallback saudável: ${healthy.join(", ")}` }
        : { ...base, status: "down", detail: "provider fora e sem fallback saudável" };
    }
    memo.set(name, result);
    return result;
  };

  const profiles = names.map(resolve);
  // Agregado: `ok` só com providers e todos os profiles ok; `down` quando
  // nenhum profile tem caminho saudável; caso contrário, `degraded`.
  const status: HealthStatus =
    profiles.every((p) => p.status === "down")
      ? "down"
      : profiles.every((p) => p.status === "ok") && providers.status === "ok"
        ? "ok"
        : "degraded";
  return { status, profiles, providers };
}