import { readFileSync } from "node:fs";
import { CAPABILITY_KEYS, isKnownCapability, missingCapabilities, type Capability } from "./capabilities";
import { CAPACITY_TAGS, ROLE_TAGS, isKnownTag } from "./tags";

/** Configuração comum a todos os providers. */
interface ProviderConfigBase {
  /** Domínio de quota compartilhado entre credenciais (default: "default"). */
  quotaDomain?: string;
  /** Headers extras enviados ao provider (ex.: HTTP-Referer, X-Title). */
  headers?: Record<string, string>;
  /** Ordem na cadeia de fallback (C6); menor atende primeiro. Default 100 (D-15). */
  priority?: number;
  /** Providers a tentar em falha (C6, D-14); `[]` desabilita o fallback. */
  fallback?: string[];
  /** Retries por provider além da primeira tentativa (C6). Default 2. */
  maxRetries?: number;
  /** Base do backoff linear entre retries em ms (C6). Default 1000. */
  retryBackoffMs?: number;
}

/** Provider OpenAI-compatible (NVIDIA NIM, OpenRouter). */
export interface OpenAICompatProviderConfig extends ProviderConfigBase {
  kind: "openai-compat";
  baseUrl: string;
  /** Nome da variável de ambiente que guarda a chave. Nunca o valor. */
  credentialRef: string;
}

/** Provider Codex via OAuth (Responses API). */
export interface CodexOAuthProviderConfig extends ProviderConfigBase {
  kind: "codex-oauth";
  credentialsPath: string;
  baseUrl?: string;
}

/** Configuração de provider fornecida por plugin (F7-1): kind custom, shape opaco. */
export interface PluginProviderConfig extends ProviderConfigBase {
  /** Qualquer kind que não seja openai-compat/codex-oauth; a factory vive no plugin. */
  kind: string;
  [key: string]: unknown;
}

/** União discriminada por `kind`. */
export type ProviderConfig = OpenAICompatProviderConfig | CodexOAuthProviderConfig | PluginProviderConfig;

export interface PriceConfig {
  inputPerM: number;
  outputPerM: number;
  fonte: string;
  verificado: boolean;
}

export type ModelStatus = "active" | "deprecated" | "disabled";

export interface ModelConfig {
  provider: string;
  id: string;
  tags: string[];
  context: number;
  status?: ModelStatus;
  price?: PriceConfig;
  /** Matriz de capability (F-07): chaves do vocabulário fechado; ausente = não tem. */
  capabilities?: Partial<Record<Capability, boolean>>;
}

/** Profile da model pool (F-27, ADR-0007): alias declarativo para um modelo de `models[]`. */
export interface ProfileConfig {
  /** Modelo resolvido: precisa existir em "models" e estar active. */
  model: string;
  /** Capabilities exigidas do modelo (F-07); validadas no startup. */
  capabilities?: Capability[];
  /** Profiles alternativos; reservado à F-31 (validação de ciclos lá). */
  fallback?: string[];
}

/** Configuração de um agent (pode ser o principal ou um agent nomeado em `agents`). */
export interface AgentConfig {
  model: string;
  maxSteps: number;
  tools: string[];
  systemPrompt?: string;
  /** Agent inicial para sessão multi-agent (default: "planner"). */
  entryAgent?: string;
  /** Profile da model pool (F-27, ADR-0007); substitui `model` quando definido. */
  profile?: string;
}

/** Configuração de agents nomeados (para multi-agent F3+). Campos opcionais herdam do agent principal. */
export interface NamedAgentConfig {
  model: string;
  maxSteps?: number;
  tools?: string[];
  systemPrompt?: string;
  /** Profile da model pool (F-27, ADR-0007); substitui `model` quando definido. */
  profile?: string;
}

/** Configuração de tools específicas (por nome da tool). */
export interface ToolsConfig {
  run_command?: RunCommandToolConfig;
}

export interface RunCommandToolConfig {
  /** Executar comandos em container Docker efêmero isolado (default: false). */
  sandbox?: boolean;
}

/** Telemetria opt-in (F5-5): métricas anônimas por run; off por default. */
export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  /** Fração de runs enviados, 0..1 (default: 1). */
  sampleRate: number;
}

/** Limite de quota por quotaDomain (F6-3); pelo menos um campo. */
export interface QuotaLimitConfig {
  dailyTokens?: number;
  monthlyCostUsd?: number;
}

/** Completion cache (F6-4): off por default; SQLite em .astro/cache.db. */
export interface CacheConfig {
  enabled: boolean;
  ttlHours: number;
  maxEntries: number;
}

/** Team features (F7-5): budget do projeto, quotas por agent, webhook de auditoria. */
export interface TeamSectionConfig {
  projectBudgetUsd?: number;
  agentQuotas?: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>;
  auditWebhook?: string;
}

/** Handoff (F-24): timeout do ack de recebimento (D-15). */
export interface HandoffConfig {
  ackTimeoutMs: number;
}

/** Default do timeout de ack (F-24, D-15). */
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

export interface PathsConfig {
  ledger: string;
  audit: string;
}

export interface AstroConfig {
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
  /** Model pool (F-27, ADR-0007): profiles resolvem para modelos de `models[]`. */
  modelPool?: Record<string, ProfileConfig>;
  agent: AgentConfig;
  agents?: Record<string, NamedAgentConfig>;
  tools?: ToolsConfig;
  telemetry?: TelemetryConfig;
  /** Limites por quotaDomain (F6-3). */
  quota?: Record<string, QuotaLimitConfig>;
  cache?: CacheConfig;
  /** Caminhos ou pacotes de plugins a carregar (F7-1). */
  plugins?: string[];
  /** Versão semântica da config (x.y.z) para sharing (F7-4). */
  version?: string;
  /** Recursos de time (F7-5). */
  team?: TeamSectionConfig;
  /** Handoff (F-24): timeout do ack; default 30000ms (D-15). */
  handoff?: HandoffConfig;
  /** Tabela de preços global (C6): key `provider/model-id` sobrescreve `model.price` para custo. */
  pricing?: Record<string, PriceConfig>;
  paths: PathsConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MODEL_STATUSES: readonly ModelStatus[] = ["active", "deprecated", "disabled"];

function fail(message: string): never {
  throw new ConfigError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`config inválida: "${field}" deve ser um objeto`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`config inválida: "${field}" deve ser uma string não vazia`);
  }
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    fail(`config inválida: "${field}" deve ser uma lista de strings`);
  }
  return value.map((item: unknown, index: number) => expectString(item, `${field}[${index}]`));
}

function expectNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`config inválida: "${field}" deve ser um número finito maior ou igual a zero`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`config inválida: "${field}" deve ser um inteiro positivo`);
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  const n = expectNonNegativeNumber(value, field);
  if (!Number.isInteger(n)) {
    fail(`config inválida: "${field}" deve ser um inteiro não negativo`);
  }
  return n;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    fail(`config inválida: "${field}" deve ser booleano`);
  }
  return value;
}

function validateHeaders(value: unknown, field: string): Record<string, string> {
  const raw = expectObject(value, field);
  const headers: Record<string, string> = Object.create(null);
  for (const [name, headerValue] of Object.entries(raw)) {
    if (name.trim().length === 0) {
      fail(`config inválida: "${field}" contém um nome de header vazio`);
    }
    headers[name] = expectString(headerValue, `${field}.${name}`);
  }
  return headers;
}

function validateProvider(name: string, value: unknown): ProviderConfig {
  const field = `providers.${name}`;
  const raw = expectObject(value, field);
  const kind = raw.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    fail(`config inválida: "${field}.kind" deve ser uma string não vazia`);
  }

  const quotaDomain =
    raw.quotaDomain === undefined ? "default" : expectString(raw.quotaDomain, `${field}.quotaDomain`);
  const headers = raw.headers === undefined ? undefined : validateHeaders(raw.headers, `${field}.headers`);
  // C6: campos de fallback — prioridade/retries validados; nomes cruzados depois
  const fallbackFields = {
    ...(raw.priority === undefined ? {} : { priority: expectPositiveInteger(raw.priority, `${field}.priority`) }),
    ...(raw.fallback === undefined ? {} : { fallback: expectStringArray(raw.fallback, `${field}.fallback`) }),
    ...(raw.maxRetries === undefined ? {} : { maxRetries: expectNonNegativeInteger(raw.maxRetries, `${field}.maxRetries`) }),
    ...(raw.retryBackoffMs === undefined ? {} : { retryBackoffMs: expectPositiveInteger(raw.retryBackoffMs, `${field}.retryBackoffMs`) }),
  };

  if (kind === "openai-compat") {
    return {
      kind,
      baseUrl: expectString(raw.baseUrl, `${field}.baseUrl`),
      credentialRef: expectString(raw.credentialRef, `${field}.credentialRef`),
      quotaDomain,
      ...(headers === undefined ? {} : { headers }),
      ...fallbackFields,
    };
  }

  if (kind === "codex-oauth") {
    const baseUrl = raw.baseUrl === undefined ? undefined : expectString(raw.baseUrl, `${field}.baseUrl`);
    return {
      kind,
      credentialsPath: expectString(raw.credentialsPath, `${field}.credentialsPath`),
      quotaDomain,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(headers === undefined ? {} : { headers }),
      ...fallbackFields,
    };
  }

  // Kind de plugin (F7-1): shape opaco; a factory é exigida em runtime
  return {
    ...raw,
    kind,
    quotaDomain,
    ...(headers === undefined ? {} : { headers }),
    ...fallbackFields,
  } as PluginProviderConfig;
}

function validateStatus(value: unknown, field: string): ModelStatus {
  if (typeof value !== "string" || !(MODEL_STATUSES as readonly string[]).includes(value)) {
    fail(`config inválida: "${field}" deve ser "active", "deprecated" ou "disabled"`);
  }
  return value as ModelStatus;
}

function validatePrice(value: unknown, field: string): PriceConfig {
  const raw = expectObject(value, field);
  return {
    inputPerM: expectNonNegativeNumber(raw.inputPerM, `${field}.inputPerM`),
    outputPerM: expectNonNegativeNumber(raw.outputPerM, `${field}.outputPerM`),
    fonte: expectString(raw.fonte, `${field}.fonte`),
    verificado: expectBoolean(raw.verificado, `${field}.verificado`),
  };
}

/** Valida `models[*].capabilities` (F-07): vocabulário fechado, valores booleanos. */
function validateCapabilities(value: unknown, field: string): Partial<Record<Capability, boolean>> {
  const raw = expectObject(value, field);
  const result: Partial<Record<Capability, boolean>> = Object.create(null);
  for (const [key, flag] of Object.entries(raw)) {
    if (!isKnownCapability(key)) {
      fail(
        `config inválida: capability "${key}" desconhecida em "${field}" ` +
          `(conhecidas: ${CAPABILITY_KEYS.join(", ")})`,
      );
    }
    result[key as Capability] = expectBoolean(flag, `${field}.${key}`);
  }
  return result;
}

function validateModel(value: unknown, index: number): ModelConfig {
  const field = `models[${index}]`;
  const raw = expectObject(value, field);
  const provider = expectString(raw.provider, `${field}.provider`);
  const id = expectString(raw.id, `${field}.id`);

  if (!Array.isArray(raw.tags)) {
    fail(`config inválida: "${field}.tags" deve ser uma lista de tags`);
  }
  const tags = raw.tags.map((tag: unknown, tagIndex: number) => {
    const name = expectString(tag, `${field}.tags[${tagIndex}]`);
    if (!isKnownTag(name)) {
      fail(
        `config inválida: tag "${name}" desconhecida em "${field}.tags" ` +
          `(papel: ${ROLE_TAGS.join(", ")}; capacidade: ${CAPACITY_TAGS.join(", ")})`,
      );
    }
    return name;
  });

  const context = expectPositiveInteger(raw.context, `${field}.context`);
  const status = raw.status === undefined ? "active" : validateStatus(raw.status, `${field}.status`);
  const price = raw.price === undefined ? undefined : validatePrice(raw.price, `${field}.price`);
  const capabilities =
    raw.capabilities === undefined
      ? undefined
      : validateCapabilities(raw.capabilities, `${field}.capabilities`);

  return {
    provider,
    id,
    tags,
    context,
    status,
    ...(price === undefined ? {} : { price }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

/**
 * Valida a seção opcional `modelPool` (F-27, ADR-0007): todo profile referencia
 * um modelo `active` de `models[]`; capabilities exigidas são checadas no
 * startup (F-07); `fallback` aponta para profiles existentes (ciclos: F-31).
 */
function validateModelPool(value: unknown, models: ModelConfig[]): Record<string, ProfileConfig> {
  const raw = expectObject(value, "modelPool");
  const result: Record<string, ProfileConfig> = Object.create(null);
  const byKey = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));

  for (const [name, profileRaw] of Object.entries(raw)) {
    if (name.trim().length === 0) fail('config inválida: "modelPool" contém um nome de profile vazio');
    const field = `modelPool.${name}`;
    const p = expectObject(profileRaw, field);
    const model = expectString(p.model, `${field}.model`);
    const entry = byKey.get(model);
    if (entry === undefined) {
      fail(`config inválida: profile "${name}" referencia o modelo "${model}", que não está declarado em "models"`);
    }
    if (entry.status !== "active") {
      fail(`config inválida: profile "${name}" referencia o modelo "${model}" que não está active (status: "${entry.status}")`);
    }

    let capabilities: Capability[] | undefined;
    if (p.capabilities !== undefined) {
      const capsRaw = expectStringArray(p.capabilities, `${field}.capabilities`);
      for (const cap of capsRaw) {
        if (!isKnownCapability(cap)) {
          fail(`config inválida: capability "${cap}" desconhecida em "${field}.capabilities" (conhecidas: ${CAPABILITY_KEYS.join(", ")})`);
        }
      }
      capabilities = capsRaw as Capability[];
      const missing = missingCapabilities(entry, capabilities);
      if (missing.length > 0) {
        fail(`config inválida: profile "${name}" exige capabilities ausentes no modelo "${model}": ${missing.join(", ")}`);
      }
    }

    let fallback: string[] | undefined;
    if (p.fallback !== undefined) {
      fallback = expectStringArray(p.fallback, `${field}.fallback`);
      if (fallback.length === 0) fail(`config inválida: "${field}.fallback" não pode ser uma lista vazia`);
    }

    result[name] = { model, ...(capabilities === undefined ? {} : { capabilities }), ...(fallback === undefined ? {} : { fallback }) };
  }

  for (const [name, profile] of Object.entries(result)) {
    for (const target of profile.fallback ?? []) {
      if (!Object.hasOwn(result, target)) {
        fail(`config inválida: "modelPool.${name}.fallback" aponta para o profile "${target}", que não está declarado em "modelPool"`);
      }
    }
  }

  return result;
}

/** Resolve o profile de um agent (F-27): XOR com `model`; devolve o model resolvido. */
function resolveProfileField(
  field: string,
  raw: Record<string, unknown>,
  modelPool?: Record<string, ProfileConfig>,
): { profile: string; model: string } {
  const profile = expectString(raw.profile, `${field}.profile`);
  if (raw.model !== undefined) {
    fail(`config inválida: "${field}" define "model" e "profile"; use apenas um — o profile substitui o model (ADR-0007)`);
  }
  const entry = modelPool?.[profile];
  if (entry === undefined) {
    fail(`config inválida: "${field}.profile" referencia o profile "${profile}", que não está declarado em "modelPool"`);
  }
  return { profile, model: entry.model };
}

function validateAgent(value: unknown, modelPool?: Record<string, ProfileConfig>): AgentConfig {
  const raw = expectObject(value, "agent");
  const systemPrompt =
    raw.systemPrompt === undefined ? undefined : expectString(raw.systemPrompt, "agent.systemPrompt");

  // F-27 (ADR-0007): profile substitui model; os dois juntos são ambíguos.
  if (raw.profile !== undefined) {
    const { profile, model } = resolveProfileField("agent", raw, modelPool);
    return {
      model,
      profile,
      maxSteps: expectPositiveInteger(raw.maxSteps, "agent.maxSteps"),
      tools: expectStringArray(raw.tools, "agent.tools"),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    };
  }

  return {
    model: expectString(raw.model, "agent.model"),
    maxSteps: expectPositiveInteger(raw.maxSteps, "agent.maxSteps"),
    tools: expectStringArray(raw.tools, "agent.tools"),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

function validatePaths(value: unknown): PathsConfig {
  const raw = expectObject(value, "paths");
  return {
    ledger: expectString(raw.ledger, "paths.ledger"),
    audit: expectString(raw.audit, "paths.audit"),
  };
}

/** Valida um agent nomeado (em `agents`). Usa defaults do agent principal se omitido. */
function validateNamedAgent(
  name: string,
  value: unknown,
  baseAgent: AgentConfig,
  knownTools: Set<string>,
  knownModels: Set<string>,
  allModels: ModelConfig[],
  modelPool?: Record<string, ProfileConfig>,
): NamedAgentConfig {
  const field = `agents.${name}`;
  const raw = expectObject(value, field);

  const systemPrompt = raw.systemPrompt === undefined ? undefined : expectString(raw.systemPrompt, `${field}.systemPrompt`);
  const maxSteps = raw.maxSteps === undefined ? baseAgent.maxSteps : expectPositiveInteger(raw.maxSteps, `${field}.maxSteps`);
  let tools = baseAgent.tools;
  if (raw.tools !== undefined) {
    tools = expectStringArray(raw.tools, `${field}.tools`);
    for (const tool of tools) {
      if (!knownTools.has(tool)) {
        fail(`config inválida: agent "${name}" tool "${tool}" desconhecida (disponíveis: ${[...knownTools].join(", ")})`);
      }
    }
  }

  // F-27 (ADR-0007): profile substitui model; os dois juntos são ambíguos.
  if (raw.profile !== undefined) {
    const { profile, model } = resolveProfileField(field, raw, modelPool);
    return { model, maxSteps, tools, profile, ...(systemPrompt === undefined ? {} : { systemPrompt }) };
  }

  const model = raw.model === undefined ? baseAgent.model : expectString(raw.model, `${field}.model`);
  if (!knownModels.has(model)) {
    fail(`config inválida: agent "${name}" referencia modelo "${model}" não declarado em "models"`);
  }
  // Verificar se o modelo está active
  const modelEntry = allModels.find((m) => `${m.provider}/${m.id}` === model);
  if (modelEntry && modelEntry.status !== "active") {
    fail(`config inválida: agent "${name}" referencia modelo "${model}" que não está active (status: "${modelEntry.status}")`);
  }

  return { model, maxSteps, tools, ...(systemPrompt === undefined ? {} : { systemPrompt }) };
}

/** Valida a seção opcional `cache` (F6-4): defaults 24h/10000 entradas. */
function validateCache(value: unknown): CacheConfig {
  const raw = expectObject(value, "cache");
  const enabled = raw.enabled === undefined ? false : expectBoolean(raw.enabled, "cache.enabled");
  const ttlHours =
    raw.ttlHours === undefined ? 24 : expectNonNegativeNumber(raw.ttlHours, "cache.ttlHours");
  const maxEntries =
    raw.maxEntries === undefined ? 10_000 : expectPositiveInteger(raw.maxEntries, "cache.maxEntries");
  return { enabled, ttlHours, maxEntries };
}

/** Valida a seção opcional `quota` (F6-3): limites por quotaDomain. */
function validateQuota(value: unknown): Record<string, QuotaLimitConfig> {
  const raw = expectObject(value, "quota");
  const result: Record<string, QuotaLimitConfig> = Object.create(null);

  for (const [domain, limitRaw] of Object.entries(raw)) {
    if (domain.trim().length === 0) {
      fail('config inválida: "quota" contém um domínio vazio');
    }
    const field = `quota.${domain}`;
    const limit = expectObject(limitRaw, field);
    const dailyTokens =
      limit.dailyTokens === undefined
        ? undefined
        : expectPositiveInteger(limit.dailyTokens, `${field}.dailyTokens`);
    const monthlyCostUsd =
      limit.monthlyCostUsd === undefined
        ? undefined
        : expectNonNegativeNumber(limit.monthlyCostUsd, `${field}.monthlyCostUsd`);

    if (dailyTokens === undefined && monthlyCostUsd === undefined) {
      fail(`config inválida: "${field}" precisa de dailyTokens ou monthlyCostUsd`);
    }
    result[domain] = {
      ...(dailyTokens === undefined ? {} : { dailyTokens }),
      ...(monthlyCostUsd === undefined ? {} : { monthlyCostUsd }),
    };
  }
  return result;
}

/** Valida a seção opcional `team` (F7-5). */
function validateTeam(value: unknown): TeamSectionConfig {
  const raw = expectObject(value, "team");
  const result: TeamSectionConfig = Object.create(null);

  if (raw.projectBudgetUsd !== undefined) {
    result.projectBudgetUsd = expectNonNegativeNumber(raw.projectBudgetUsd, "team.projectBudgetUsd");
  }
  if (raw.auditWebhook !== undefined) {
    result.auditWebhook = expectString(raw.auditWebhook, "team.auditWebhook");
  }
  if (raw.agentQuotas !== undefined) {
    const quotasRaw = expectObject(raw.agentQuotas, "team.agentQuotas");
    const agentQuotas: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }> = Object.create(null);
    for (const [agent, quotaRaw] of Object.entries(quotasRaw)) {
      const field = `team.agentQuotas.${agent}`;
      const quota = expectObject(quotaRaw, field);
      const dailyTokens =
        quota.dailyTokens === undefined
          ? undefined
          : expectPositiveInteger(quota.dailyTokens, `${field}.dailyTokens`);
      const monthlyCostUsd =
        quota.monthlyCostUsd === undefined
          ? undefined
          : expectNonNegativeNumber(quota.monthlyCostUsd, `${field}.monthlyCostUsd`);
      if (dailyTokens === undefined && monthlyCostUsd === undefined) {
        fail(`config inválida: "${field}" precisa de dailyTokens ou monthlyCostUsd`);
      }
      agentQuotas[agent] = {
        ...(dailyTokens === undefined ? {} : { dailyTokens }),
        ...(monthlyCostUsd === undefined ? {} : { monthlyCostUsd }),
      };
    }
    result.agentQuotas = agentQuotas;
  }
  return result;
}

/** Valida a seção `handoff` (F-24); ausente aplica o default 30000ms (D-15). */
function validateHandoff(value: unknown): HandoffConfig {
  const raw = value === undefined ? {} : expectObject(value, "handoff");
  return {
    ackTimeoutMs:
      raw.ackTimeoutMs === undefined
        ? DEFAULT_ACK_TIMEOUT_MS
        : expectPositiveInteger(raw.ackTimeoutMs, "handoff.ackTimeoutMs"),
  };
}

/** Valida a seção opcional `telemetry` (F5-5): off por default, sem PII. */
function validateTelemetry(value: unknown): TelemetryConfig {
  const raw = expectObject(value, "telemetry");
  const enabled = raw.enabled === undefined ? false : expectBoolean(raw.enabled, "telemetry.enabled");
  const endpoint =
    raw.endpoint === undefined
      ? "https://telemetry.astro.local/v1/runs"
      : expectString(raw.endpoint, "telemetry.endpoint");
  let sampleRate = raw.sampleRate === undefined ? 1 : expectNonNegativeNumber(raw.sampleRate, "telemetry.sampleRate");
  if (sampleRate > 1) sampleRate = 1;
  return { enabled, endpoint, sampleRate };
}

/** Valida a seção opcional `tools`. */
function validateTools(value: unknown): ToolsConfig {
  const raw = expectObject(value, "tools");
  const result: ToolsConfig = Object.create(null);

  if (raw.run_command !== undefined) {
    const rcRaw = expectObject(raw.run_command, "tools.run_command");
    const sandbox = rcRaw.sandbox === undefined ? false : expectBoolean(rcRaw.sandbox, "tools.run_command.sandbox");
    result.run_command = { sandbox };
  }

  return result;
}

/**
 * Valida a configuração crua (tipicamente vinda de JSON) e aplica os defaults:
 * `status: "active"` por modelo e `quotaDomain: "default"` por provider.
 */
export function validateConfig(raw: unknown): AstroConfig {
  const root = expectObject(raw, "config");

  const providersRaw = expectObject(root.providers, "providers");
  const providers: Record<string, ProviderConfig> = Object.create(null);
  for (const [name, providerRaw] of Object.entries(providersRaw)) {
    providers[name] = validateProvider(name, providerRaw);
  }

  if (!Array.isArray(root.models)) {
    fail('config inválida: "models" deve ser uma lista de modelos');
  }
  const models = root.models.map((modelRaw: unknown, index: number) => validateModel(modelRaw, index));

  const seenModels = new Set<string>();
  for (const model of models) {
    if (!Object.hasOwn(providers, model.provider)) {
      fail(
        `config inválida: modelo "${model.provider}/${model.id}" aponta para o provider ` +
          `"${model.provider}", que não está declarado em "providers"`,
      );
    }
    const key = `${model.provider}/${model.id}`;
    if (seenModels.has(key)) {
      fail(`config inválida: modelo duplicado "${key}" em "models"`);
    }
    seenModels.add(key);
  }

  // C6: cadeia de fallback referencia providers declarados
  for (const [name, provider] of Object.entries(providers)) {
    for (const target of provider.fallback ?? []) {
      if (!Object.hasOwn(providers, target)) {
        fail(`config inválida: "providers.${name}.fallback" aponta para o provider "${target}", que não está declarado`);
      }
    }
  }

  // C6: tabela de preços global — key `provider/model-id` de modelo declarado
  let pricing: Record<string, PriceConfig> | undefined;
  if (root.pricing !== undefined) {
    const pricingRaw = expectObject(root.pricing, "pricing");
    const table: Record<string, PriceConfig> = Object.create(null);
    for (const [key, priceRaw] of Object.entries(pricingRaw)) {
      if (!seenModels.has(key)) {
        fail(`config inválida: "pricing.${key}" não corresponde a um modelo declarado em "models"`);
      }
      table[key] = validatePrice(priceRaw, `pricing.${key}`);
    }
    pricing = table;
  }

  // Model pool (F-27, ADR-0007): profiles resolvem para modelos de models[]
  const modelPool =
    root.modelPool === undefined ? undefined : validateModelPool(root.modelPool, models);

  const agent = validateAgent(root.agent, modelPool);
  if (!seenModels.has(agent.model)) {
    fail(
      `config inválida: "agent.model" referencia o modelo "${agent.model}", ` +
        `que não está declarado em "models"`,
    );
  }

  // Validar agents nomeados (F3-1)
  const agents: Record<string, NamedAgentConfig> = Object.create(null);
  if (root.agents !== undefined) {
    const agentsRaw = expectObject(root.agents, "agents");
    const knownTools = new Set(agent.tools);
    for (const [name, agentRaw] of Object.entries(agentsRaw)) {
      agents[name] = validateNamedAgent(name, agentRaw, agent, knownTools, seenModels, models, modelPool);
    }
  }

  // Validar seção tools (F4-6)
  const tools = root.tools === undefined ? undefined : validateTools(root.tools);

  // Validar telemetria (F5-5)
  const telemetry = root.telemetry === undefined ? undefined : validateTelemetry(root.telemetry);

  // Validar quota (F6-3)
  const quota = root.quota === undefined ? undefined : validateQuota(root.quota);

  // Validar cache (F6-4)
  const cache = root.cache === undefined ? undefined : validateCache(root.cache);

  // Validar plugins (F7-1): lista de strings não vazias
  let plugins: string[] | undefined;
  if (root.plugins !== undefined) {
    plugins = expectStringArray(root.plugins, "plugins");
  }

  // Versão semântica (F7-4): x.y.z quando presente
  let version: string | undefined;
  if (root.version !== undefined) {
    version = expectString(root.version, "version");
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      fail(`config inválida: "version" deve ser semântica x.y.z (recebido: "${version}")`);
    }
  }

  // Team features (F7-5)
  const team = root.team === undefined ? undefined : validateTeam(root.team);

  // Handoff (F-24): timeout do ack com default seguro (D-15)
  const handoff = validateHandoff(root.handoff);

  const paths = validatePaths(root.paths);

  return { providers, models, modelPool, agent, agents, tools, telemetry, quota, cache, plugins, version, team, handoff, ...(pricing === undefined ? {} : { pricing }), paths };
}

/** Lê um arquivo JSON de configuração e o valida. */
export function loadConfig(path: string): AstroConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`não foi possível ler a configuração em "${path}": ${detail}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`configuração em "${path}" não é JSON válido: ${detail}`);
  }

  return validateConfig(raw);
}
