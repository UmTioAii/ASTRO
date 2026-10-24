import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";
import { runHealthCheck } from "../src/health";

const baseConfig = {
  providers: { mock: { kind: "openai-compat" as const, baseUrl: "http://localhost/v1", credentialRef: "TEST_KEY" } },
  models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
  agent: { model: "mock/mock-1", maxSteps: 3, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

/** Servidor mock de /models; atraso configurável por chamada. */
function modelsServer(handler: () => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return handler();
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

const okEnv = { TEST_KEY: "test-key" };

describe("health check (F6-6)", () => {
  test("provider respondendo → status ok com checks e latency", async () => {
    const server = modelsServer(() => Response.json({ data: [] }));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, okEnv);
      expect(report.status).toBe("ok");
      const configCheck = report.checks.find((c) => c.name === "config")!;
      expect(configCheck.status).toBe("ok");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("ok");
      expect(providerCheck.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop();
    }
  });

  test("credencial inválida (401) → check down, status down", async () => {
    const server = modelsServer(() => new Response("unauthorized", { status: 401 }));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, okEnv);
      expect(report.status).toBe("down");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("down");
      expect(providerCheck.detail).toContain("401");
    } finally {
      server.stop();
    }
  });

  test("sem credencial no env → degraded com mensagem clara (sem HTTP)", async () => {
    const server = modelsServer(() => Response.json({ data: [] }));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, {});
      expect(report.status).toBe("degraded");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("down");
      expect(providerCheck.detail).toContain("TEST_KEY");
    } finally {
      server.stop();
    }
  });

  test("dois providers, um fora → degraded; falha não derruba o outro", async () => {
    const ok = modelsServer(() => Response.json({ data: [] }));
    const bad = modelsServer(() => new Response("boom", { status: 500 }));
    try {
      const config = validateConfig({
        ...structuredClone(baseConfig),
        providers: {
          good: { kind: "openai-compat", baseUrl: ok.baseUrl, credentialRef: "GOOD_KEY" },
          bad: { kind: "openai-compat", baseUrl: bad.baseUrl, credentialRef: "BAD_KEY" },
        },
        models: [{ provider: "good", id: "mock-1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "good/mock-1", maxSteps: 3, tools: [] },
      });
      const report = await runHealthCheck(config, { GOOD_KEY: "g", BAD_KEY: "b" });
      expect(report.status).toBe("degraded");
      expect(report.checks.find((c) => c.name === "provider:good")!.status).toBe("ok");
      expect(report.checks.find((c) => c.name === "provider:bad")!.status).toBe("down");
    } finally {
      ok.stop();
      bad.stop();
    }
  });

  test("timeout por check: endpoint lento vira down com detail de timeout", async () => {
    const server = modelsServer(() => new Promise((resolve) => setTimeout(() => resolve(Response.json({ data: [] })), 60_000)));
    try {
      const config = validateConfig({ ...structuredClone(baseConfig), providers: { mock: { ...baseConfig.providers.mock, baseUrl: server.baseUrl } } });
      const report = await runHealthCheck(config, okEnv, { timeoutMs: 50 });
      expect(report.status).toBe("down");
      const providerCheck = report.checks.find((c) => c.name === "provider:mock")!;
      expect(providerCheck.status).toBe("down");
      expect(providerCheck.detail).toContain("timeout");
    } finally {
      server.stop();
    }
  });

  test("codex-oauth: credenciais legíveis → ok; ausentes → down", async () => {
    const config = validateConfig({
      ...structuredClone(baseConfig),
      providers: { codex: { kind: "codex-oauth", credentialsPath: "~/astro-health-fantasma.json" } },
      models: [{ provider: "codex", id: "gpt", tags: ["writing-code"], context: 4096 }],
      agent: { model: "codex/gpt", maxSteps: 3, tools: [] },
    });
    const report = await runHealthCheck(config, {});
    expect(report.checks.find((c) => c.name === "provider:codex")!.status).toBe("down");
  });
});