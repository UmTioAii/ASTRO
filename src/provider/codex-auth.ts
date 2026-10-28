import { readFileSync } from "node:fs";
import { isAbortError, throwIfAborted } from "../abort";
import type { ErrorClass, FetchLike } from "./types";
import { ProviderError } from "./types";

/** Tokens do Codex mantidos em memória; `expiresAt` em segundos desde a epoch (claim `exp`). */
export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
}

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringClaim(claims: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = claims?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberClaim(claims: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = claims?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Decodifica o payload do JWT sem validar a assinatura (só leitura de claims). */
function readClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined;
  const payload = token.split(".")[1];
  if (payload === undefined || payload.length === 0) return undefined;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lê `~/.codex/auth.json` (somente leitura) e extrai os tokens do Codex.
 * Erros citam o caminho, nunca o conteúdo do arquivo.
 */
export function readCodexAuth(path: string): CodexTokens {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ProviderError("auth", `não foi possível ler as credenciais do Codex (auth.json) em ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError("auth", `credenciais do Codex (auth.json) inválidas em ${path}: JSON inválido`);
  }

  const tokens = isRecord(parsed) && isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const accessToken = stringClaim(tokens, "access_token");
  const refreshToken = stringClaim(tokens, "refresh_token");
  const accountId =
    stringClaim(tokens, "account_id") ??
    stringClaim(readClaims(stringClaim(tokens, "id_token")), "chatgpt_account_id");
  const expiresAt = numberClaim(readClaims(accessToken), "exp");

  if (accessToken === undefined || refreshToken === undefined) {
    throw new ProviderError("auth", `credenciais do Codex (auth.json) inválidas em ${path}: tokens ausentes`);
  }
  if (accountId === undefined) {
    throw new ProviderError("auth", `credenciais do Codex (auth.json) inválidas em ${path}: account_id ausente`);
  }
  if (expiresAt === undefined) {
    throw new ProviderError("auth", `credenciais do Codex (auth.json) inválidas em ${path}: access token sem exp`);
  }

  return { accessToken, refreshToken, accountId, expiresAt };
}

/**
 * Renova os tokens em memória via endpoint OAuth do Codex.
 * Não grava no `auth.json`; o arquivo de credenciais permanece somente leitura.
 */
export async function refreshCodexTokens(
  tokens: CodexTokens,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  throwIfAborted(signal);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new ProviderError("outage", "falha de rede ao renovar as credenciais do Codex");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderError(
      "outage",
      "falha ao ler a resposta da renovação das credenciais do Codex",
      response.status,
    );
  }

  if (!response.ok) {
    throw refreshError(response.status, text);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderError(
      "outage",
      "resposta da renovação das credenciais do Codex não é JSON válido",
      response.status,
    );
  }

  const fields = isRecord(payload) ? payload : undefined;
  const accessToken = stringClaim(fields, "access_token");
  if (accessToken === undefined) {
    throw new ProviderError(
      "outage",
      'resposta da renovação das credenciais do Codex sem "access_token"',
      response.status,
    );
  }

  const refreshToken = stringClaim(fields, "refresh_token") ?? tokens.refreshToken;
  const expiresIn = numberClaim(fields, "expires_in");
  const expiresAt =
    numberClaim(readClaims(accessToken), "exp") ??
    Math.floor(Date.now() / 1000) + (expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS);

  return { accessToken, refreshToken, accountId: tokens.accountId, expiresAt };
}

function refreshError(status: number, body: string): ProviderError {
  if (status === 429) {
    const errClass: ErrorClass = body.toLowerCase().includes("insufficient_quota")
      ? "hard_quota"
      : "transient_rate_limit";
    return new ProviderError(errClass, "renovação das credenciais do Codex limitada (HTTP 429)", status);
  }
  if (status >= 500) {
    return new ProviderError("outage", `renovação das credenciais do Codex falhou (HTTP ${status})`, status);
  }
  if (status >= 400) {
    return new ProviderError(
      "auth",
      `renovação das credenciais do Codex recusada (HTTP ${status}); faça login novamente no Codex`,
      status,
    );
  }
  return new ProviderError("outage", `renovação das credenciais do Codex falhou (HTTP ${status})`, status);
}
