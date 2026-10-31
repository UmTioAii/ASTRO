import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, validateConfig } from "../src/config";
import { CodexOAuthProvider } from "../src/provider/codex-oauth";
import { OpenAICompatProvider } from "../src/provider/openai-compat";
import { errorPolicy } from "../src/provider/policy";
import { ProviderError } from "../src/provider/types";

const req = { model: "m", messages: [{ role: "user" as const, content: "oi" }] };

/** Servidor pendurado: só termina quando o sinal da chamada aborta. */
const hungFetch = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

const jwt = (payload: object) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

const authPath = (exp: number) => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-timeout-")), "auth.json");
  writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt({ exp }), refresh_token: "r1", account_id: "acct_1" } }));
  return path;
};

test("openai-compat: servidor pendurado vira network_timeout", async () => {
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
    timeoutMs: 20,
    retry: { maxAttempts: 1 },
    fetchFn: hungFetch,
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.errClass).not.toBe("hard_quota");
});

test("openai-compat: abort do caller continua sendo cancelamento, não timeout", async () => {
  const controller = new AbortController();
  const p = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
    timeoutMs: 5_000,
    retry: { maxAttempts: 1 },
    fetchFn: hungFetch,
  });

  setTimeout(() => controller.abort(new DOMException("cancelado", "AbortError")), 10);
  const error = (await p.complete(req, controller.signal).catch((e) => e)) as Error;
  expect(error.name).toBe("AbortError");
});

test("codex-oauth: servidor pendurado vira network_timeout", async () => {
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(4102444800),
    timeoutMs: 20,
    fetchFn: hungFetch,
  });

  const error = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.errClass).toBe("network_timeout");
  expect(error.message).not.toContain(jwt({ exp: 4102444800 }));
});

test("policy: network_timeout retenta com backoff e nunca faz skip de quota", () => {
  expect(errorPolicy("network_timeout", 1)).toBe("retry_backoff");
  expect(errorPolicy("network_timeout", 99)).toBe("fallback");
});

test("config aceita provider.timeoutMs e rejeita valor não positivo", () => {
  const base = {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };

  const config = validateConfig({
    ...structuredClone(base),
    providers: { p: { ...base.providers.p, timeoutMs: 2500 } },
  });
  expect(config.providers.p.timeoutMs).toBe(2500);

  expect(() => validateConfig({
    ...structuredClone(base),
    providers: { p: { ...base.providers.p, timeoutMs: 0 } },
  })).toThrow(ConfigError);
});
