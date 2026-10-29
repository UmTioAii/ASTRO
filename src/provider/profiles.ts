/** Perfis de provider persistidos fora do projeto (~/.astro/providers.json). Sem segredo. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, loadConfig, validateConfig, type AstroConfig, type ModelConfig, type ProviderConfig } from "../config";
import { isKnownTag } from "../tags";

export interface ProfileModel {
  id: string;
  tags: string[];
  context: number;
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  /** Nome da variável de ambiente; nunca o valor. Ausente = provider sem chave. */
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  headers?: Record<string, string>;
  models: ProfileModel[];
}

export interface ProviderStore {
  version: 1;
  activeProfileId?: string;
  profiles: ProviderProfile[];
}

const ROOT_KEYS = new Set(["version", "activeProfileId", "profiles"]);
const PROFILE_KEYS = new Set([
  "id", "name", "kind", "baseUrl", "credentialRef", "credentialsPath", "quotaDomain", "headers", "models",
]);
const AUTH_HEADERS = /(^|-)authorization$|(^|-)api[-_]?key$|(^|-)key$|(^|-)secret$|^cookie$|^set-cookie$|^x-auth-|token$/;
const SECRET_VALUE = /^(sk-|nvapi-|AIza|ghp_|github_pat_|glpat-|xox[baprs]-)/;
const SENSITIVE_QUERY = /^(api[-_]?key|key|token|access[-_]?token|secret)$/i;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Credencial cabe em qualquer header que carregue auth, não só nos quatro óbvios. */
function isAuthHeader(name: string): boolean {
  return AUTH_HEADERS.test(name.toLowerCase());
}

function fail(message: string): never {
  throw new Error(`perfil inválido: ${message}`);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`"${field}" deve ser um objeto`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`"${field}" deve ser uma string não vazia`);
  }
  return value;
}

function rejectUnknown(raw: Record<string, unknown>, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(`campo desconhecido: "${field}.${key}"`);
  }
}

function validateHeaders(raw: unknown, field: string): Record<string, string> {
  const headers = asObject(raw, field);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isAuthHeader(name)) {
      fail(`header de autenticação não é permitido em "${field}": "${name.toLowerCase()}"`);
    }
    const text = asString(value, `${field}.${name}`);
    if (SECRET_VALUE.test(text.trim())) {
      fail(`"${field}.${name}" parece conter uma credencial; use credentialRef`);
    }
    out[name] = text;
  }
  return out;
}

function validateModel(raw: unknown, field: string): ProfileModel {
  const model = asObject(raw, field);
  rejectUnknown(model, new Set(["id", "tags", "context"]), field);
  const id = asString(model.id, `${field}.id`);
  if (!Array.isArray(model.tags)) fail(`"${field}.tags" deve ser uma lista de tags`);
  const tags = model.tags.map((tag, index) => {
    const name = asString(tag, `${field}.tags[${index}]`);
    if (!isKnownTag(name)) fail(`tag "${name}" desconhecida em "${field}.tags"`);
    return name;
  });
  const context = model.context;
  if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) {
    fail(`"${field}.context" deve ser um inteiro positivo`);
  }
  return { id, tags, context };
}

function validateBaseUrl(value: unknown, field: string): string {
  const raw = asString(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`"${field}" deve ser uma URL http(s) válida`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`"${field}" deve ser uma URL http(s) válida`);
  }
  if (url.username !== "" || url.password !== "") {
    fail(`"${field}" não pode embutir credencial; use credentialRef`);
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) {
      fail(`"${field}" não pode levar credencial na query (${key}); use credentialRef`);
    }
  }
  return raw;
}

function validateProfile(raw: unknown, field: string): ProviderProfile {
  const profile = asObject(raw, field);
  rejectUnknown(profile, PROFILE_KEYS, field);
  const id = asString(profile.id, `${field}.id`);
  if (!PROFILE_ID.test(id) || id.length > 64) {
    fail(`"${field}.id" deve ser um slug (minúsculas, dígitos e hífen; até 64 caracteres)`);
  }
  const name = asString(profile.name, `${field}.name`);
  const kind = asString(profile.kind, `${field}.kind`);
  const baseUrl = profile.baseUrl === undefined ? undefined : validateBaseUrl(profile.baseUrl, `${field}.baseUrl`);
  const credentialRef = profile.credentialRef === undefined
    ? undefined
    : asString(profile.credentialRef, `${field}.credentialRef`);
  if (credentialRef !== undefined && !ENV_NAME.test(credentialRef)) {
    fail(`"${field}.credentialRef" deve ser um nome de variável de ambiente (ex.: OPENAI_API_KEY)`);
  }
  const credentialsPath = profile.credentialsPath === undefined
    ? undefined
    : asString(profile.credentialsPath, `${field}.credentialsPath`);
  const quotaDomain = profile.quotaDomain === undefined
    ? undefined
    : asString(profile.quotaDomain, `${field}.quotaDomain`);
  const headers = profile.headers === undefined
    ? undefined
    : validateHeaders(profile.headers, `${field}.headers`);
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    fail(`"${field}.models" deve ter ao menos um modelo`);
  }
  const models = profile.models.map((model, index) => validateModel(model, `${field}.models[${index}]`));
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) fail(`modelo duplicado em "${field}.models": "${model.id}"`);
    modelIds.add(model.id);
  }

  if (kind === "openai-compat" && baseUrl === undefined) {
    fail(`"${field}.baseUrl" é obrigatório para kind "openai-compat"`);
  }
  if (kind === "codex-oauth" && credentialsPath === undefined) {
    fail(`"${field}.credentialsPath" é obrigatório para kind "codex-oauth"`);
  }

  return {
    id, name, kind,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    ...(quotaDomain === undefined ? {} : { quotaDomain }),
    ...(headers === undefined ? {} : { headers }),
    models,
  };
}

/** Valida o store inteiro; campo desconhecido é erro, nunca ignorado. */
export function validateProfileStore(raw: unknown): ProviderStore {
  const root = asObject(raw, "store");
  rejectUnknown(root, ROOT_KEYS, "store");
  if (root.version !== 1) fail(`"version" deve ser 1`);
  if (!Array.isArray(root.profiles)) fail(`"profiles" deve ser uma lista`);
  const profiles = root.profiles.map((profile, index) => validateProfile(profile, `profiles[${index}]`));

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) fail(`id duplicado: "${profile.id}"`);
    const nameKey = profile.name.toLowerCase();
    if (names.has(nameKey)) fail(`nome duplicado: "${profile.name}"`);
    ids.add(profile.id);
    names.add(nameKey);
  }

  const activeProfileId = root.activeProfileId === undefined
    ? undefined
    : asString(root.activeProfileId, "activeProfileId");

  return {
    version: 1,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    profiles,
  };
}

/** Caminho do store: `$ASTRO_HOME/providers.json` ou `~/.astro/providers.json`. */
export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  const base = home === undefined || home === "" ? join(homedir(), ".astro") : home;
  return join(base, "providers.json");
}

/** Store ausente é um store vazio; JSON corrompido é erro com o caminho. */
export function loadProfileStore(path: string = profilesPath()): ProviderStore {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: 1, profiles: [] };
    throw new Error(`store de perfis inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.trim() === "") return { version: 1, profiles: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Nunca ecoar o detalhe do parser: ele cita os primeiros caracteres do
    // conteúdo colado, que pode ser uma chave (I-03).
    throw new Error(`store de perfis inválido em "${path}": JSON inválido`);
  }
  try {
    return validateProfileStore(parsed);
  } catch (error) {
    throw new Error(`store de perfis inválido em "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Valida antes de gravar; escrita atômica com modo 0600 no POSIX. */
export function saveProfileStore(store: ProviderStore, path: string = profilesPath()): void {
  const valid = validateProfileStore(store);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    throw error;
  }
}

export type ProviderSource = "project" | "global" | "env";

/** Quem escolheu o provider ativo (a definição pode vir de outro lugar). */
export type ProviderSelection = "flag" | "env" | "store" | "project";

export interface EffectiveConfig {
  config: AstroConfig;
  activeProvider: string;
  /** Origem da definição do provider ativo. */
  providerSource: ProviderSource;
  /** Origem da escolha do provider ativo. */
  providerSelection: ProviderSelection;
  warnings: string[];
}

/** Primeiro run sem config é somente leitura; escrita/shell exigem config explícita. */
const BASELINE_TOOLS = ["read_file", "list_dir", "grep"];
const BASELINE_PATHS = { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" };
const ENV_MODEL_CONTEXT = 128_000;

/** Perfil efêmero a partir de OPENAI_*; nunca é gravado. */
export function profileFromEnv(env: NodeJS.ProcessEnv): ProviderProfile | undefined {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL ?? env.ASTRO_MODEL;
  if (apiKey === undefined || apiKey === "" || model === undefined || model === "") return undefined;
  const profile: ProviderProfile = {
    id: "env",
    name: "OpenAI (env)",
    kind: "openai-compat",
    baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    credentialRef: "OPENAI_API_KEY",
    models: [{ id: model, tags: [], context: ENV_MODEL_CONTEXT }],
  };
  // Mesmo validador do store: rejeita URL com credencial embutida, etc.
  return validateProfileStore({ version: 1, profiles: [profile] }).profiles[0];
}

function profileToProvider(profile: ProviderProfile): ProviderConfig {
  if (profile.kind === "codex-oauth") {
    return {
      kind: "codex-oauth",
      credentialsPath: profile.credentialsPath ?? "~/.codex/auth.json",
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      ...(profile.headers === undefined ? {} : { headers: profile.headers }),
      ...(profile.quotaDomain === undefined ? {} : { quotaDomain: profile.quotaDomain }),
    };
  }
  return {
    kind: profile.kind,
    baseUrl: profile.baseUrl ?? "",
    ...(profile.credentialRef === undefined ? {} : { credentialRef: profile.credentialRef }),
    ...(profile.headers === undefined ? {} : { headers: profile.headers }),
    ...(profile.quotaDomain === undefined ? {} : { quotaDomain: profile.quotaDomain }),
  };
}

function providerOfModel(modelRef: string, providers: Record<string, ProviderConfig>): string | undefined {
  return Object.keys(providers)
    .sort((a, b) => b.length - a.length)
    .find((name) => modelRef.startsWith(`${name}/`));
}

function mergeModels(global: ModelConfig[], project: ModelConfig[]): ModelConfig[] {
  const merged = new Map<string, ModelConfig>();
  for (const model of global) merged.set(`${model.provider}/${model.id}`, model);
  for (const model of project) merged.set(`${model.provider}/${model.id}`, model);
  return [...merged.values()];
}

/** Mescla perfis globais com o projeto e resolve o provider ativo. */
export function resolveEffectiveConfig(input: {
  project?: AstroConfig;
  store: ProviderStore;
  envProfile?: ProviderProfile;
  providerFlag?: string;
  env?: NodeJS.ProcessEnv;
}): EffectiveConfig {
  const env = input.env ?? process.env;
  const warnings: string[] = [];
  const project = input.project;

  const profiles = new Map(input.store.profiles.map((profile) => [profile.id, profile]));
  if (input.envProfile !== undefined) {
    if (profiles.has(input.envProfile.id)) {
      warnings.push('perfil salvo "env" foi ignorado nesta sessão; renomeie-o para não colidir');
    }
    profiles.set(input.envProfile.id, input.envProfile);
  }

  const globalProviders: Record<string, ProviderConfig> = {};
  const globalModels: ModelConfig[] = [];
  for (const profile of profiles.values()) {
    globalProviders[profile.id] = profileToProvider(profile);
    for (const model of profile.models) {
      globalModels.push({ provider: profile.id, id: model.id, tags: model.tags, context: model.context });
    }
  }

  const providers = { ...globalProviders, ...(project?.providers ?? {}) };
  const models = mergeModels(globalModels, project?.models ?? []);
  const projectProvider = project === undefined ? undefined : providerOfModel(project.agent.model, providers);

  let requested: string | undefined;
  let requestKind: ProviderSelection | undefined;
  if (input.providerFlag !== undefined) { requested = input.providerFlag; requestKind = "flag"; }
  else if (env.ASTRO_PROVIDER !== undefined && env.ASTRO_PROVIDER !== "") { requested = env.ASTRO_PROVIDER; requestKind = "env"; }
  else if (input.store.activeProfileId !== undefined) { requested = input.store.activeProfileId; requestKind = "store"; }

  const pooled = project?.agent.profile !== undefined;
  if (pooled) {
    if (requested !== undefined && requested !== projectProvider) {
      warnings.push("agent.profile tem precedência sobre a troca de provider");
    }
    requested = undefined;
    requestKind = undefined;
  }

  let activeProvider: string | undefined;
  let selection: ProviderSelection = "project";
  if (requested !== undefined) {
    if (Object.hasOwn(providers, requested)) {
      activeProvider = requested;
      selection = requestKind ?? "project";
    } else if (requestKind === "store") {
      warnings.push(`activeProfileId "${requested}" não corresponde a nenhum perfil; usando o projeto`);
    } else {
      throw new Error(`provider "${requested}" não está configurado`);
    }
  }
  if (activeProvider === undefined) {
    if (projectProvider !== undefined) { activeProvider = projectProvider; selection = "project"; }
    else if (input.envProfile !== undefined) { activeProvider = input.envProfile.id; selection = "env"; }
    else if (input.store.profiles[0] !== undefined) { activeProvider = input.store.profiles[0].id; selection = "store"; }
    else {
      throw new Error(
        "nenhum provider configurado: rode /provider add ou defina OPENAI_API_KEY e OPENAI_MODEL",
      );
    }
  }

  const currentProvider = projectProvider;
  let modelRef: string;
  if (project !== undefined && !pooled && currentProvider === activeProvider) {
    modelRef = project.agent.model;
  } else if (project !== undefined && pooled) {
    modelRef = project.agent.model;
  } else {
    const currentId = currentProvider === undefined ? undefined : project?.agent.model.slice(currentProvider.length + 1);
    const candidates = models.filter(
      (model) => model.provider === activeProvider && (model.status ?? "active") === "active",
    );
    const kept = currentId === undefined ? undefined : candidates.find((model) => model.id === currentId);
    const chosen = kept ?? candidates[0];
    if (chosen === undefined) throw new Error(`provider "${activeProvider}" não tem modelo ativo`);
    modelRef = `${chosen.provider}/${chosen.id}`;
  }

  const base = project ?? {
    providers,
    models,
    agent: { model: modelRef, maxSteps: 12, tools: [...BASELINE_TOOLS] },
    paths: { ...BASELINE_PATHS },
  };
  if (project === undefined) {
    warnings.push(
      "usando configuração padrão somente leitura (sem astro.config.json); crie o arquivo para liberar escrita",
    );
  }

  const { model: _resolvedModel, ...agentSansModel } = base.agent;
  const config = validateConfig({
    ...base,
    providers,
    models,
    agent: pooled ? agentSansModel : { ...base.agent, model: modelRef },
  });
  const providerSource: ProviderSource = project !== undefined && Object.hasOwn(project.providers, activeProvider)
    ? "project"
    : input.envProfile !== undefined && activeProvider === input.envProfile.id
      ? "env"
      : "global";

  return { config, activeProvider, providerSource, providerSelection: selection, warnings };
}

/** Carrega o projeto, o store global e o perfil de env, e resolve. */
export function loadEffectiveConfig(
  configPath: string,
  opts: { env?: NodeJS.ProcessEnv; provider?: string; storePath?: string; allowMissing?: boolean } = {},
): EffectiveConfig {
  const env = opts.env ?? process.env;
  const exists = existsSync(configPath);
  if (!exists && opts.allowMissing !== true) {
    throw new ConfigError(`configuração não encontrada: "${configPath}"`);
  }
  const project = exists ? loadConfig(configPath) : undefined;
  const store = loadProfileStore(opts.storePath ?? profilesPath(env));
  const envProfile = profileFromEnv(env);
  return resolveEffectiveConfig({
    ...(project === undefined ? {} : { project }),
    store,
    ...(envProfile === undefined ? {} : { envProfile }),
    ...(opts.provider === undefined ? {} : { providerFlag: opts.provider }),
    env,
  });
}
