import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_KEYS, isKnownCapability, missingCapabilities, type Capability } from "./capabilities";
import { PROTECTED_FORBIDDEN_ROOTS, type CallConfig, type EffortLevel, type ThinkingMode } from "./call-profile";
import { isAuthHeader, looksLikeSecret } from "./secrets";
import { headerEnvName, isValidHeaderName } from "./mcp/headers";
import { urlProblem } from "./url-safety";
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
  /** Nome da variável de ambiente que guarda a chave. Nunca o valor. Ausente = provider sem chave. */
  credentialRef?: string;
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
  /** Call profile (E1–E8): effort, thinking e parâmetros proibidos. */
  call?: CallConfig;
  /** Eficiência relativa (M6/M8): maior primeiro; usada só quando falta preço. */
  efficiency?: number;
}

/** Profile da model pool (F-27, ADR-0007): alias declarativo para um modelo de `models[]`. */
export interface ProfileConfig {
  /** Modelo resolvido: precisa existir em "models" e estar active. */
  model: string;
  /** Capabilities exigidas do modelo (F-07); validadas no startup. */
  capabilities?: Capability[];
  /** Profiles alternativos (F-31); `[]` desabilita, igual a ausente. */
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

/** Escopo do budget (B1, D-CFG1). */
export type BudgetScope = "day" | "month" | "project" | "use-as-you-go";

/** Ação no esgotamento (B4): perguntar (com checkpoint sem TTY) ou parar. */
export type BudgetOnExceed = "ask" | "stop";

/** Budget (B1–B10, I-17): escopo, aviso, decisão e corte físico. */
export interface BudgetConfig {
  scope: BudgetScope;
  /** null = use-as-you-go (B2): registra e exibe, nunca bloqueia. */
  limitUsd: number | null;
  /** Fração de aviso (0 < warnAt < 1); default 0.8. */
  warnAt: number;
  /** Default "ask". */
  onExceed: BudgetOnExceed;
  /** Corte físico (B10, I-17); ausente = sem teto absoluto. */
  hardCeilingUsd?: number;
}

/** Seção `run` (Q-01/L2): teto de turnos por execução. */
export interface RunConfig {
  maxTurns?: number | "unlimited";
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

/** Servidor MCP (C2, #56): o `command` do stdio é código arbitrário — modelo de confiança na doc. */
export interface MCPServerConfig {
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  /** Variáveis explícitas para o servidor; o resto do env é sanitizado (I-03). */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Base do backoff exponencial entre reconexões em ms; teto de 30s (default 1000). */
  retryBackoffMs?: number;
  timeoutMs: number;
  enabled: boolean;
}

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
  /** Teto declarado de agentes ativos (A2); v1 aplica no máximo 2. */
  maxActive?: number;
  tools?: ToolsConfig;
  telemetry?: TelemetryConfig;
  /** Limites por quotaDomain (F6-3). */
  quota?: Record<string, QuotaLimitConfig>;
  /** Budget (B1–B10, I-17); ausente = sem camada de budget. */
  budget?: BudgetConfig;
  /** Seção `run` (Q-01): `maxTurns` numérico ou "unlimited". */
  run?: RunConfig;
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
  /** Servidores MCP (C2, #56): key é o nome usado no namespace mcp__<server>__<tool>. */
  mcpServers?: Record<string, MCPServerConfig>;
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

/**
 * Conta de um provider (A2/A4), na mesma forma que o runtime usa em
 * `providerIdentity`: a credencial nomeada, o arquivo OAuth expandido ou o
 * `kind` para provider de plugin. Sem chave, o próprio provider é a conta.
 */
export function providerAccountRefFor(name: string, provider: ProviderConfig): string {
  const raw = provider as { kind: string; credentialRef?: unknown; credentialsPath?: unknown };
  if (raw.kind === "openai-compat") {
    return typeof raw.credentialRef === "string" && raw.credentialRef.length > 0
      ? raw.credentialRef
      : `provider:${name}`;
  }
  if (raw.kind === "codex-oauth") {
    return typeof raw.credentialsPath === "string"
      ? expandHome(raw.credentialsPath)
      : `provider:${name}`;
  }
  if (typeof raw.credentialRef === "string") return raw.credentialRef;
  return raw.kind;
}

/** Mesma expansão de `~` usada pelo runtime para o caminho de credenciais. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function validateHeaders(value: unknown, field: string): Record<string, string> {
  const raw = expectObject(value, field);
  const headers: Record<string, string> = Object.create(null);
  for (const [name, headerValue] of Object.entries(raw)) {
    if (name.trim().length === 0) {
      fail(`config inválida: "${field}" contém um nome de header vazio`);
    }
    if (isAuthHeader(name)) {
      fail(`config inválida: "${field}.${name}" é header de autenticação; use credentialRef`);
    }
    const text = expectString(headerValue, `${field}.${name}`);
    if (looksLikeSecret(text)) {
      fail(`config inválida: "${field}.${name}" parece conter uma credencial; use credentialRef`);
    }
    headers[name] = text;
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
    const baseUrl = expectString(raw.baseUrl, `${field}.baseUrl`);
    const baseUrlIssue = urlProblem(baseUrl);
    if (baseUrlIssue !== undefined) fail(`config inválida: "${field}.baseUrl" ${baseUrlIssue}`);
    return {
      kind,
      baseUrl,
      ...(raw.credentialRef === undefined
        ? {}
        : { credentialRef: expectString(raw.credentialRef, `${field}.credentialRef`) }),
      quotaDomain,
      ...(headers === undefined ? {} : { headers }),
      ...fallbackFields,
    };
  }

  if (kind === "codex-oauth") {
    const baseUrl = raw.baseUrl === undefined ? undefined : expectString(raw.baseUrl, `${field}.baseUrl`);
    if (baseUrl !== undefined) {
      const baseUrlIssue = urlProblem(baseUrl);
      if (baseUrlIssue !== undefined) fail(`config inválida: "${field}.baseUrl" ${baseUrlIssue}`);
    }
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

const THINKING_MODES: ReadonlySet<string> = new Set(["toggle", "always", "adaptive", "none"]);
const EFFORT_LEVELS: readonly EffortLevel[] = ["0", "1", "2", "3", "4"];
const CALL_KEYS: ReadonlySet<string> = new Set(["thinking", "effort", "forbidden"]);
const THINKING_KEYS: ReadonlySet<string> = new Set(["mode", "param", "on", "off"]);
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Rejeita caminho vazio, chave de protótipo ou raiz de protocolo protegida. */
function validateParamPath(path: string, field: string): void {
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0 || UNSAFE_PATH_SEGMENTS.has(part))) {
    fail(`config inválida: "${field}" contém caminho de parâmetro inválido "${path}"`);
  }
  const root = parts[0]!;
  if ((PROTECTED_FORBIDDEN_ROOTS as readonly string[]).includes(root)) {
    fail(`config inválida: "${field}" não pode apontar para a raiz protegida "${root}"`);
  }
}

/** Valida `models[].call` (D-CFG1): non-discard em todo campo (E1–E8). */
function validateCall(value: unknown, field: string): CallConfig {
  const raw = expectObject(value, field);
  for (const key of Object.keys(raw)) {
    if (!CALL_KEYS.has(key)) fail(`config inválida: "${field}.${key}" desconhecido em call`);
  }

  let thinking: CallConfig["thinking"];
  if (raw.thinking !== undefined) {
    const f = `${field}.thinking`;
    const t = expectObject(raw.thinking, f);
    for (const key of Object.keys(t)) {
      if (!THINKING_KEYS.has(key)) fail(`config inválida: "${f}.${key}" desconhecido em call.thinking`);
    }
    const mode = expectString(t.mode, `${f}.mode`);
    if (!THINKING_MODES.has(mode)) {
      fail(`config inválida: "${f}.mode" deve ser toggle, always, adaptive ou none`);
    }
    const param = expectString(t.param, `${f}.param`);
    validateParamPath(param, `${f}.param`);
    const on = t.on === undefined ? undefined : expectString(t.on, `${f}.on`);
    const off = t.off === undefined ? undefined : expectString(t.off, `${f}.off`);
    if (mode !== "none" && on === undefined) {
      fail(`config inválida: "${f}.on" é obrigatório no modo "${mode}"`);
    }
    if (mode === "toggle" && off === undefined) {
      fail(`config inválida: "${f}.off" é obrigatório no modo "toggle"`);
    }
    if (mode === "none" && (on !== undefined || off !== undefined)) {
      fail(`config inválida: "${f}.on"/"${f}.off" não se aplicam ao modo "none"`);
    }
    if ((mode === "always" || mode === "adaptive") && off !== undefined) {
      fail(`config inválida: "${f}.off" não se aplica ao modo "${mode}"`);
    }
    thinking = {
      mode: mode as ThinkingMode,
      param,
      ...(on === undefined ? {} : { on }),
      ...(off === undefined ? {} : { off }),
    };
  }

  let effort: CallConfig["effort"];
  if (raw.effort !== undefined) {
    const f = `${field}.effort`;
    const e = expectObject(raw.effort, f);
    for (const key of Object.keys(e)) {
      if (key !== "param" && key !== "map") fail(`config inválida: "${f}.${key}" desconhecido em call.effort`);
    }
    const param = expectString(e.param, `${f}.param`);
    validateParamPath(param, `${f}.param`);
    const mapRaw = expectObject(e.map, `${f}.map`);
    for (const key of Object.keys(mapRaw)) {
      if (!(EFFORT_LEVELS as readonly string[]).includes(key)) {
        fail(`config inválida: "${f}.map.${key}" não é um nível de esforço (0..4)`);
      }
    }
    const map = {} as Record<EffortLevel, string>;
    for (const level of EFFORT_LEVELS) {
      map[level] = expectString(mapRaw[level], `${f}.map.${level}`);
    }
    effort = { param, map };
  }

  let forbidden: string[] | undefined;
  if (raw.forbidden !== undefined) {
    if (!Array.isArray(raw.forbidden)) {
      fail(`config inválida: "${field}.forbidden" deve ser uma lista de parâmetros`);
    }
    forbidden = raw.forbidden.map((item: unknown, index: number) => {
      const name = expectString(item, `${field}.forbidden[${index}]`);
      validateParamPath(name, `${field}.forbidden[${index}]`);
      return name;
    });
    const seen = new Set<string>();
    for (const name of forbidden) {
      if (seen.has(name)) fail(`config inválida: "${field}.forbidden" contém "${name}" duplicado`);
      seen.add(name);
    }
  }

  return {
    ...(thinking === undefined ? {} : { thinking }),
    ...(effort === undefined ? {} : { effort }),
    ...(forbidden === undefined ? {} : { forbidden }),
  };
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
  const call = raw.call === undefined ? undefined : validateCall(raw.call, `${field}.call`);
  const efficiency = raw.efficiency === undefined
    ? undefined
    : expectNonNegativeNumber(raw.efficiency, `${field}.efficiency`);
  if (efficiency !== undefined && efficiency > 1) {
    fail(`config inválida: "${field}.efficiency" deve estar entre 0 e 1`);
  }

  return {
    provider,
    id,
    tags,
    context,
    status,
    ...(price === undefined ? {} : { price }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(call === undefined ? {} : { call }),
    ...(efficiency === undefined ? {} : { efficiency }),
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
    }

    result[name] = { model, ...(capabilities === undefined ? {} : { capabilities }), ...(fallback === undefined ? {} : { fallback }) };
  }

  for (const [name, profile] of Object.entries(result)) {
    for (const target of profile.fallback ?? []) {
      if (!Object.hasOwn(result, target)) {
        fail(`config inválida: "modelPool.${name}.fallback" aponta para o profile "${target}", que não está declarado em "modelPool"`);
      }
      if (target === name) {
        fail(`config inválida: "modelPool.${name}.fallback" não pode referenciar o próprio profile (autorreferência)`);
      }
    }
  }

  // F-31: a cadeia de profiles precisa ser acíclica (determinismo, I-06).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(" -> ");
      fail(`config inválida: ciclo em "modelPool.*.fallback": ${cycle}`);
    }
    visiting.add(name);
    stack.push(name);
    for (const target of result[name]?.fallback ?? []) visit(target);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(result)) visit(name);

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
  // entryAgent default "planner" (A13, Q-03, pinado em tests/tool-isolation.test.ts)
  const entryAgent = raw.entryAgent === undefined ? "planner" : expectString(raw.entryAgent, "agent.entryAgent");

  // F-27 (ADR-0007): profile substitui model; os dois juntos são ambíguos.
  if (raw.profile !== undefined) {
    const { profile, model } = resolveProfileField("agent", raw, modelPool);
    return {
      model,
      profile,
      maxSteps: expectPositiveInteger(raw.maxSteps, "agent.maxSteps"),
      tools: expectStringArray(raw.tools, "agent.tools"),
      entryAgent,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    };
  }

  return {
    model: expectString(raw.model, "agent.model"),
    maxSteps: expectPositiveInteger(raw.maxSteps, "agent.maxSteps"),
    tools: expectStringArray(raw.tools, "agent.tools"),
    entryAgent,
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

const BUDGET_SCOPES: readonly BudgetScope[] = ["day", "month", "project", "use-as-you-go"];

/** Valida a seção opcional `budget` (B1, D-CFG1) — cada campo é non-discard. */
function validateBudget(value: unknown): BudgetConfig {
  const raw = expectObject(value, "budget");
  const scope = raw.scope;
  if (!BUDGET_SCOPES.includes(scope as BudgetScope)) {
    fail('config inválida: "budget.scope" deve ser day, month, project ou use-as-you-go');
  }
  if (!Object.hasOwn(raw, "limitUsd")) {
    fail('config inválida: "budget.limitUsd" é obrigatório (use null para use-as-you-go)');
  }
  let limitUsd: number | null;
  if (scope === "use-as-you-go") {
    if (raw.limitUsd !== null) fail('config inválida: "budget.limitUsd" deve ser null em scope "use-as-you-go"');
    limitUsd = null;
  } else {
    if (raw.limitUsd === null) fail(`config inválida: "budget.limitUsd" não pode ser null em scope "${scope}"`);
    limitUsd = expectNonNegativeNumber(raw.limitUsd, "budget.limitUsd");
  }
  const warnAt = raw.warnAt === undefined ? 0.8 : expectNonNegativeNumber(raw.warnAt, "budget.warnAt");
  if (warnAt <= 0 || warnAt >= 1) fail('config inválida: "budget.warnAt" deve estar entre 0 e 1 (exclusivo)');
  const onExceed = raw.onExceed === undefined ? "ask" : raw.onExceed;
  if (onExceed !== "ask" && onExceed !== "stop") fail('config inválida: "budget.onExceed" deve ser "ask" ou "stop"');
  const hardCeilingUsd =
    raw.hardCeilingUsd === undefined
      ? undefined
      : expectNonNegativeNumber(raw.hardCeilingUsd, "budget.hardCeilingUsd");
  return {
    scope: scope as BudgetScope,
    limitUsd,
    warnAt,
    onExceed,
    ...(hardCeilingUsd === undefined ? {} : { hardCeilingUsd }),
  };
}

/** Valida a seção opcional `run` (Q-01): inteiro positivo ou "unlimited". */
function validateRun(value: unknown): RunConfig {
  const raw = expectObject(value, "run");
  if (raw.maxTurns === undefined) return {};
  return { maxTurns: raw.maxTurns === "unlimited" ? "unlimited" : expectPositiveInteger(raw.maxTurns, "run.maxTurns") };
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

const MCP_TRANSPORTS: readonly MCPServerConfig["transport"][] = ["stdio", "sse", "http"];

/** Valida um registro de strings (env/headers de mcpServers). */
function stringRecord(raw: Record<string, unknown>, field: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val !== "string") fail(`config inválida: "${field}.${key}" deve ser string`);
    out[key] = val;
  }
  return out;
}

/** Headers de MCP: aceita literal não-secreto ou referência `env:NOME` (I-03). */
function mcpHeaders(raw: Record<string, unknown>, field: string): Record<string, string> {
  const headers = stringRecord(raw, field);
  for (const [name, value] of Object.entries(headers)) {
    if (!isValidHeaderName(name)) {
      fail(`config inválida: "${field}.${name}" não é um nome de header válido`);
    }
    if (value.startsWith("env:")) {
      if (headerEnvName(value) === undefined) {
        fail(`config inválida: "${field}.${name}" deve usar "env:NOME_DA_VARIAVEL"`);
      }
      continue;
    }
    if (isAuthHeader(name) || looksLikeSecret(value)) {
      fail(`config inválida: "${field}.${name}" parece conter credencial; use "env:NOME_DA_VARIAVEL"`);
    }
  }
  return headers;
}

/** Valida a seção `mcpServers` (C2, #56); defaults timeoutMs 30000 e enabled true. */
function validateMcpServers(value: unknown): Record<string, MCPServerConfig> {
  const raw = expectObject(value, "mcpServers");
  const result: Record<string, MCPServerConfig> = Object.create(null);
  for (const [name, serverRaw] of Object.entries(raw)) {
    const field = `mcpServers.${name}`;
    if (name.includes("__") || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      fail(`config inválida: "mcpServers.${name}" deve ser um nome com letras, números, "_" ou "-" (sem "__" nem "/")`);
    }
    const raw2 = expectObject(serverRaw, field);
    const transport = raw2.transport;
    if (typeof transport !== "string" || !MCP_TRANSPORTS.includes(transport as MCPServerConfig["transport"])) {
      fail(`config inválida: "${field}.transport" deve ser stdio, sse ou http`);
    }
    const trans = transport as MCPServerConfig["transport"];
    if (raw2.command !== undefined && typeof raw2.command !== "string") {
      fail(`config inválida: "${field}.command" deve ser string`);
    }
    if (trans === "stdio" && (raw2.command === undefined || (raw2.command as string).trim() === "")) {
      fail(`config inválida: "${field}.command" obrigatório para transport stdio`);
    }
    if (trans !== "stdio" && (raw2.url === undefined || typeof raw2.url !== "string")) {
      fail(`config inválida: "${field}.url" obrigatório para transport ${trans}`);
    }
    let args: string[] = [];
    if (raw2.args !== undefined) {
      if (!Array.isArray(raw2.args) || raw2.args.some((arg) => typeof arg !== "string")) {
        fail(`config inválida: "${field}.args" deve ser uma lista de strings`);
      }
      args = raw2.args as string[];
    }
    const env = raw2.env === undefined ? undefined : stringRecord(expectObject(raw2.env, `${field}.env`), `${field}.env`);
    const headers = raw2.headers === undefined ? undefined : mcpHeaders(expectObject(raw2.headers, `${field}.headers`), `${field}.headers`);
    const timeoutMs = raw2.timeoutMs === undefined ? 30_000 : expectPositiveInteger(raw2.timeoutMs, `${field}.timeoutMs`);
    const retryBackoffMs = raw2.retryBackoffMs === undefined
      ? undefined
      : expectPositiveInteger(raw2.retryBackoffMs, `${field}.retryBackoffMs`);
    const enabled = raw2.enabled === undefined ? true : expectBoolean(raw2.enabled, `${field}.enabled`);
    result[name] = {
      transport: trans,
      ...(raw2.command === undefined ? {} : { command: raw2.command as string }),
      args,
      ...(env === undefined ? {} : { env }),
      ...(raw2.url === undefined ? {} : { url: raw2.url as string }),
      ...(headers === undefined ? {} : { headers }),
      ...(retryBackoffMs === undefined ? {} : { retryBackoffMs }),
      timeoutMs,
      enabled,
    };
  }
  return result;
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

  // Validar agents nomeados (F3-1). `maxActive` é reservado (A2): não é agente.
  const agents: Record<string, NamedAgentConfig> = Object.create(null);
  let maxActive: number | undefined;
  if (root.agents !== undefined) {
    const agentsRaw = expectObject(root.agents, "agents");
    const knownTools = new Set(agent.tools);
    for (const [name, agentRaw] of Object.entries(agentsRaw)) {
      if (name === "maxActive") {
        maxActive = expectPositiveInteger(agentRaw, "agents.maxActive");
        continue;
      }
      agents[name] = validateNamedAgent(name, agentRaw, agent, knownTools, seenModels, models, modelPool);
    }
  }

  // A2 (ADR-0008): cada agente ativo consome uma conta exclusiva (A4, ADR-0009).
  // O teto efetivo da v1 é 2; `maxActive` só é validado quando declarado.
  if (Object.keys(agents).length > 0) {
    const accounts = new Set(
      Object.entries(providers).map(([name, provider]) => providerAccountRefFor(name, provider)),
    ).size;
    const ceiling = maxActive ?? 2;
    if (ceiling > accounts) {
      fail(
        `config inválida: max_active_exceeds_accounts (${ceiling} agentes ativos para ${accounts} contas declaradas)`,
      );
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

  // Budget (B1–B10) e run.maxTurns (Q-01/L2)
  const budget = root.budget === undefined ? undefined : validateBudget(root.budget);
  const run = root.run === undefined ? undefined : validateRun(root.run);
  if (
    run?.maxTurns === "unlimited" &&
    budget?.hardCeilingUsd === undefined &&
    (budget === undefined || budget.limitUsd === null)
  ) {
    fail('config inválida: run.maxTurns "unlimited" exige budget.hardCeilingUsd ou budget.limitUsd (unlimited_without_ceiling)');
  }

  // Servidores MCP (C2, #56): ausente = nenhum servidor
  const mcpServers = root.mcpServers === undefined ? undefined : validateMcpServers(root.mcpServers);

  const paths = validatePaths(root.paths);

  return { providers, models, modelPool, agent, agents, ...(maxActive === undefined ? {} : { maxActive }), tools, telemetry, quota, cache, plugins, version, team, handoff, ...(budget === undefined ? {} : { budget }), ...(run === undefined ? {} : { run }), ...(pricing === undefined ? {} : { pricing }), ...(mcpServers === undefined ? {} : { mcpServers }), paths };
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
