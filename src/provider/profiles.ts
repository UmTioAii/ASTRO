/** Perfis de provider persistidos fora do projeto (~/.astro/providers.json). Sem segredo. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
const AUTH_HEADERS = /(^|-)authorization$|(^|-)api[-_]?key$|^cookie$|^set-cookie$|^x-auth-|token$/;
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
  if (activeProfileId !== undefined && !ids.has(activeProfileId)) {
    fail(`"activeProfileId" aponta para perfil inexistente: "${activeProfileId}"`);
  }

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
