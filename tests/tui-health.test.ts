import { expect, test } from "bun:test";
import { validateConfig } from "../src/config";
import { testProvider } from "../src/health";
import { classifyProviderCheck } from "../src/tui/health";

const config = validateConfig({
  providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 1, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});

test("classifica o check de health na taxonomia de erro do provider", () => {
  expect(classifyProviderCheck({ name: "provider:p", status: "ok", latencyMs: 5 })).toBeUndefined();
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "defina OPENAI_API_KEY no ambiente" })).toBe("auth");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 401 em GET /models" })).toBe("auth");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 403 em GET /models" })).toBe("auth");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 402 em GET /models" })).toBe("hard_quota");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 429 em GET /models (insufficient_quota)" })).toBe("hard_quota");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 404 em GET /models" })).toBe("invalid_request");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 429 em GET /models" })).toBe("transient_rate_limit");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 500 em GET /models" })).toBe("outage");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "timeout de 5000ms" })).toBe("outage");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "Unable to connect" })).toBe("outage");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "ENOENT: no such file" })).toBe("auth");
});

test("probe real distingue quota esgotada de rate limit e timeout", async () => {
  const quota = await testProvider(config, "p", { KEY: "k" }, {
    timeoutMs: 100,
    fetchLike: (async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 })) as unknown as typeof fetch,
  });
  expect(classifyProviderCheck(quota)).toBe("hard_quota");

  const rate = await testProvider(config, "p", { KEY: "k" }, {
    timeoutMs: 100,
    fetchLike: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
  });
  expect(classifyProviderCheck(rate)).toBe("transient_rate_limit");

  const timeout = await testProvider(config, "p", { KEY: "k" }, {
    timeoutMs: 100,
    fetchLike: (async () => { throw new Error("The operation was aborted"); }) as unknown as typeof fetch,
  });
  expect(classifyProviderCheck(timeout)).toBe("outage");
});
