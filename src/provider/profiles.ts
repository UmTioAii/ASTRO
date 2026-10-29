/** Perfis de provider persistidos fora do projeto (~/.astro/providers.json). Sem segredo. */
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
const AUTH_HEADERS = new Set(["authorization", "api-key", "x-api-key", "x-auth-token"]);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

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
    if (AUTH_HEADERS.has(name.toLowerCase())) {
      fail(`header de autenticação não é permitido em "${field}": "${name.toLowerCase()}"`);
    }
    out[name] = asString(value, `${field}.${name}`);
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

function validateProfile(raw: unknown, field: string): ProviderProfile {
  const profile = asObject(raw, field);
  rejectUnknown(profile, PROFILE_KEYS, field);
  const id = asString(profile.id, `${field}.id`);
  const name = asString(profile.name, `${field}.name`);
  const kind = asString(profile.kind, `${field}.kind`);
  const baseUrl = profile.baseUrl === undefined ? undefined : asString(profile.baseUrl, `${field}.baseUrl`);
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
    if (names.has(profile.name)) fail(`nome duplicado: "${profile.name}"`);
    ids.add(profile.id);
    names.add(profile.name);
  }

  const activeProfileId = root.activeProfileId === undefined
    ? undefined
    : asString(root.activeProfileId, "activeProfileId");
  if (activeProfileId !== undefined && !ids.has(activeProfileId)) {
    fail(`"activeProfileId" aponta para perfil inexistente: "${activeProfileId}"`);
  }

  return {
    version: 1,
    ...(activeProfileId === undefined ? {} : { activeProfileId }),
    profiles,
  };
}
