/** Login device flow do Codex (#226): código, polling, exchange e escrita 0600. */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { throwIfAborted } from "../abort";
import { codexAccountId } from "./codex-auth";
import { ProviderError, type ErrorClass, type FetchLike } from "./types";

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 30_000;
const USER_CODE = /^[A-Z0-9-]{4,32}$/;

export interface CodexDeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}

export interface CodexLoginTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId: string;
  expiresAt: number;
}

export interface CodexLoginOptions {
  fetchLike?: FetchLike;
  issuer?: string;
  clientId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CodexLoginStart {
  device: CodexDeviceCode;
  /** Resolve depois do exchange; a gravação do `auth.json` é do chamador. */
  done: Promise<CodexLoginTokens>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = record?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readClaims(token: string | undefined): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function statusError(status: number, action: string): ProviderError {
  const errorClass: ErrorClass = status === 429 ? "transient_rate_limit" : status >= 500 ? "outage" : "auth";
  return new ProviderError(errorClass, `${action} falhou (HTTP ${status})`, status);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ProviderError("outage", "login do Codex cancelado"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError("outage", "login do Codex cancelado"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface Deadline { deadline: number; now: () => number; signal?: AbortSignal }

/** Fetch + parse com deadline e cancelamento; distingue timeout, cancelamento e rede. */
async function requestWithDeadline<T>(
  fetchLike: FetchLike,
  url: string,
  init: RequestInit,
  opts: Deadline,
  consume: (response: Response) => Promise<T>,
): Promise<{ response: Response; payload?: T }> {
  const remaining = opts.deadline - opts.now();
  if (remaining <= 0) throw new ProviderError("outage", "timeout aguardando o login do Codex");
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectAbort?.(new ProviderError("outage", "timeout aguardando o login do Codex"));
  }, remaining);
  const onAbort = (): void => {
    controller.abort();
    rejectAbort?.(new ProviderError("outage", "login do Codex cancelado"));
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new ProviderError("outage", "login do Codex cancelado");
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchLike(url, { ...init, signal: controller.signal });
    if (!response.ok) return { response };
    const payload = await Promise.race([consume(response), aborted]);
    return { response, payload };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (opts.signal?.aborted === true) throw new ProviderError("outage", "login do Codex cancelado");
    if (timedOut) throw new ProviderError("outage", "timeout aguardando o login do Codex");
    throw new ProviderError("outage", "falha de rede no login do Codex");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function requestDevice(
  fetchLike: FetchLike,
  issuer: string,
  clientId: string,
  opts: Deadline,
): Promise<CodexDeviceCode> {
  const { response, payload } = await requestWithDeadline(fetchLike, `${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  }, opts, (value) => value.json());
  if (!response.ok) throw statusError(response.status, "login do Codex");
  const fields = isRecord(payload) ? payload : undefined;
  const deviceAuthId = stringField(fields, "device_auth_id");
  const userCode = stringField(fields, "user_code") ?? stringField(fields, "usercode");
  if (deviceAuthId === undefined || userCode === undefined || !USER_CODE.test(userCode)) {
    throw new ProviderError("outage", "resposta do login do Codex com device_auth_id/user_code inválido");
  }
  const seconds = Number.parseInt(stringField(fields, "interval") ?? "5", 10);
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${issuer}/codex/device`,
    intervalMs: Math.max(Number.isFinite(seconds) ? seconds : 5, 1) * MIN_INTERVAL_MS,
  };
}

async function exchange(
  fetchLike: FetchLike,
  issuer: string,
  clientId: string,
  code: string,
  verifier: string,
  opts: Deadline,
): Promise<CodexLoginTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: clientId,
    code_verifier: verifier,
  }).toString();
  const { response, payload } = await requestWithDeadline(fetchLike, `${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, opts, (value) => value.json());
  if (!response.ok) throw statusError(response.status, "troca do código do Codex");
  const fields = isRecord(payload) ? payload : undefined;
  const accessToken = stringField(fields, "access_token");
  const refreshToken = stringField(fields, "refresh_token");
  if (accessToken === undefined || refreshToken === undefined) {
    throw new ProviderError("outage", "resposta da troca do Codex sem access_token/refresh_token");
  }
  const idToken = stringField(fields, "id_token");
  const accountId = codexAccountId(idToken) ?? codexAccountId(accessToken);
  if (accountId === undefined) throw new ProviderError("auth", "login do Codex sem account id");
  const expiresIn = numberField(fields, "expires_in");
  const expiresAt =
    numberField(readClaims(accessToken), "exp") ??
    Math.floor(opts.now() / 1000) + (expiresIn ?? 3600);
  return { accessToken, refreshToken, ...(idToken === undefined ? {} : { idToken }), accountId, expiresAt };
}

/** Inicia o device flow; `done` resolve depois do exchange (sem gravar arquivo). */
export async function startCodexLogin(opts: CodexLoginOptions = {}): Promise<CodexLoginStart> {
  const fetchLike = opts.fetchLike ?? fetch;
  const issuer = opts.issuer ?? DEFAULT_ISSUER;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const signal = opts.signal;
  throwIfAborted(signal);
  const deadline = now() + timeoutMs;

  const device = await requestDevice(fetchLike, issuer, clientId, { deadline, now, ...(signal === undefined ? {} : { signal }) });
  const done = (async (): Promise<CodexLoginTokens> => {
    let interval = device.intervalMs;
    while (true) {
      throwIfAborted(signal);
      if (now() >= deadline) throw new ProviderError("outage", "timeout aguardando o login do Codex");
      const { response, payload } = await requestWithDeadline(fetchLike, `${issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      }, { deadline, now, ...(signal === undefined ? {} : { signal }) }, (value) => value.json());
      if (response.ok) {
        const fields = isRecord(payload) ? payload : undefined;
        const code = stringField(fields, "authorization_code");
        const verifier = stringField(fields, "code_verifier");
        if (code === undefined || verifier === undefined) {
          throw new ProviderError("outage", "resposta do polling do Codex sem authorization_code/code_verifier");
        }
        return await exchange(fetchLike, issuer, clientId, code, verifier, { deadline, now, ...(signal === undefined ? {} : { signal }) });
      }
      if (response.status === 403 || response.status === 404) {
        await sleep(Math.min(interval, Math.max(deadline - now(), 0)), signal);
        continue;
      }
      if (response.status === 429) {
        interval = Math.min(interval * 2, MAX_INTERVAL_MS);
        await sleep(Math.min(interval, Math.max(deadline - now(), 0)), signal);
        continue;
      }
      throw statusError(response.status, "polling do login do Codex");
    }
  })();
  return { device, done };
}

/** Expande `~` no caminho de credenciais (mesma regra do codex-auth). */
export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Grava o `auth.json` no formato lido por `readCodexAuth`; atômico e 0600. */
export function saveCodexAuth(path: string, tokens: CodexLoginTokens): void {
  const payload = {
    tokens: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      ...(tokens.idToken === undefined ? {} : { id_token: tokens.idToken }),
      account_id: tokens.accountId,
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    throw error;
  }
}
