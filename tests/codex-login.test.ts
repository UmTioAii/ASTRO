import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/chat/agent-session";
import { readCodexAuth } from "../src/provider/codex-auth";
import { saveCodexAuth, startCodexLogin } from "../src/provider/codex-login";

const jwt = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

function loginFetch() {
  const calls: { url: string; body: string }[] = [];
  let polls = 0;
  const fetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      polls++;
      if (polls === 1) return new Response("pending", { status: 403 });
      return Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
    }
    if (url.endsWith("/oauth/token")) {
      return Response.json({
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-token",
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
        expires_in: 3600,
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchLike, calls };
}

test("device login faz request, aguarda 403 e troca o código por tokens", async () => {
  const { fetchLike, calls } = loginFetch();
  const { device, done } = await startCodexLogin({ fetchLike, sleep: async () => {} });
  expect(device).toMatchObject({ deviceAuthId: "dev-1", userCode: "ABCD-1234", intervalMs: 1000 });
  expect(device.verificationUrl).toBe("https://auth.openai.com/codex/device");

  const tokens = await done;
  expect(tokens).toMatchObject({ accessToken: expect.any(String), refreshToken: "refresh-token", accountId: "acct-1" });
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/api/accounts/deviceauth/usercode",
    "/api/accounts/deviceauth/token",
    "/api/accounts/deviceauth/token",
    "/oauth/token",
  ]);
  expect(calls.at(-1)!.body).toContain("grant_type=authorization_code");
  expect(calls.at(-1)!.body).toContain("code=auth-code");
  expect(calls.at(-1)!.body).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
});

test("device login propaga erro do servidor sem ecoar o corpo", async () => {
  const fetchLike = (async () => new Response("secret-token-should-not-leak", { status: 500 })) as unknown as typeof fetch;
  await expect(startCodexLogin({ fetchLike })).rejects.toThrow(/HTTP 500/);
  const error = await startCodexLogin({ fetchLike }).catch((value: Error) => value) as Error;
  expect(error.message).not.toContain("secret-token-should-not-leak");
});

test("device login respeita cancelamento", async () => {
  const controller = new AbortController();
  const fetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new Error("aborted");
    if (String(input).endsWith("/api/accounts/deviceauth/token")) return new Response("pending", { status: 403 });
    return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
  }) as unknown as typeof fetch;
  const { done } = await startCodexLogin({ fetchLike, signal: controller.signal, sleep: async () => { controller.abort(); } });
  await expect(done).rejects.toThrow(/cancelad|abort/i);
});

test("device login respeita timeout e resposta de polling incompleta", async () => {
  let clock = 0;
  const slow = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    }
    return new Response("pending", { status: 403 });
  }) as unknown as typeof fetch;
  const timeout = await startCodexLogin({
    fetchLike: slow,
    timeoutMs: 1000,
    now: () => clock,
    sleep: async () => { clock += 2000; },
  });
  await expect(timeout.done).rejects.toThrow(/timeout/i);

  const malformed = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const broken = await startCodexLogin({ fetchLike: malformed, timeoutMs: 1000 });
  await expect(broken.done).rejects.toThrow(/authorization_code/);
});

test("device login classifica 429 como rate limit e recusa user_code inválido", async () => {
  const rate = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
  const error = await startCodexLogin({ fetchLike: rate }).catch((value: Error) => value) as Error & { errClass?: string };
  expect(error.errClass).toBe("transient_rate_limit");

  const invalid = (async () => Response.json({ device_auth_id: "dev-1", user_code: "\u001b]0;x\u0007", interval: "1" })) as unknown as typeof fetch;
  await expect(startCodexLogin({ fetchLike: invalid })).rejects.toThrow(/user_code inválido/);
});

test("loginCodex recusa credentialsPath relativo antes de tocar a rede", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-codex-path-"));
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { c: { kind: "codex-oauth", credentialsPath: "auth.json" } },
    models: [{ provider: "c", id: "gpt-5.5", tags: ["writing-code"], context: 8192 }],
    agent: { model: "c/gpt-5.5", maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const session = new AgentSession({ configPath, cwd: dir, env: {} });
  try {
    await expect(session.loginCodex("c")).rejects.toThrow(/absoluto/);
  } finally {
    session.close();
  }
});

test("stalled body é interrompido pelo deadline", async () => {
  const fetchLike = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    }
    return new Response(new ReadableStream({ start() { /* nunca envia o corpo */ } }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const { done } = await startCodexLogin({ fetchLike, timeoutMs: 50 });
  await expect(done).rejects.toThrow(/timeout/i);
});

test("saveCodexAuth substitui o arquivo existente sem deixar lixo", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-codex-replace-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, "old-content", "utf8");
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  saveCodexAuth(path, { accessToken, refreshToken: "new-refresh", accountId: "acct-2", expiresAt: 9999999999 });
  expect(readCodexAuth(path)).toMatchObject({ accessToken, refreshToken: "new-refresh", accountId: "acct-2" });
});

test("saveCodexAuth grava o formato lido por readCodexAuth com modo 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-codex-login-"));
  const path = join(dir, "auth.json");
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  saveCodexAuth(path, { accessToken, refreshToken: "refresh", idToken, accountId: "acct-1", expiresAt: 9999999999 });
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { tokens: Record<string, unknown> };
  expect(parsed.tokens).toMatchObject({ access_token: accessToken, refresh_token: "refresh", id_token: idToken, account_id: "acct-1" });
  expect(readCodexAuth(path)).toMatchObject({ accessToken, refreshToken: "refresh", accountId: "acct-1" });
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});
