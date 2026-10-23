import { describe, expect, test } from "bun:test";
import { validateConfig, ConfigError } from "../src/config";
import { shouldSample, sendTelemetry, type TelemetryPayload } from "../src/telemetry";

const baseConfig = {
  providers: { openai: { kind: "openai-compat" as const, baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const payload: TelemetryPayload = {
  runId: "r1", model: "openai/gpt-4o-mini", tokensIn: 100, tokensOut: 50,
  latencyMs: 200, steps: 2, costUsd: 0.001,
};

describe("config telemetry (F5-5)", () => {
  test("sem seção telemetry → undefined (off)", () => {
    const cfg = validateConfig(structuredClone(baseConfig));
    expect(cfg.telemetry).toBeUndefined();
  });

  test("telemetry com defaults: disabled, endpoint default, sampleRate 1", () => {
    const raw = { ...structuredClone(baseConfig), telemetry: {} };
    const cfg = validateConfig(raw);
    expect(cfg.telemetry!.enabled).toBe(false);
    expect(cfg.telemetry!.endpoint).toContain("telemetry.astro.local");
    expect(cfg.telemetry!.sampleRate).toBe(1);
  });

  test("enabled true + endpoint custom aceitos", () => {
    const raw = { ...structuredClone(baseConfig), telemetry: { enabled: true, endpoint: "http://localhost:9999/t" } };
    const cfg = validateConfig(raw);
    expect(cfg.telemetry!.enabled).toBe(true);
    expect(cfg.telemetry!.endpoint).toBe("http://localhost:9999/t");
  });

  test("sampleRate > 1 clampa para 1", () => {
    const raw = { ...structuredClone(baseConfig), telemetry: { enabled: true, sampleRate: 5 } };
    const cfg = validateConfig(raw);
    expect(cfg.telemetry!.sampleRate).toBe(1);
  });

  test("enabled inválido → ConfigError", () => {
    const raw = { ...structuredClone(baseConfig), telemetry: { enabled: "yes" } };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });
});

describe("telemetria (F5-5)", () => {
  test("disabled → shouldSample false e sendTelemetry não envia", async () => {
    const config = { enabled: false, endpoint: "http://x", sampleRate: 1 };
    expect(shouldSample(config)).toBe(false);
    let calls = 0;
    const fetchLike = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendTelemetry(config, payload, fetchLike)).toBe(false);
    expect(calls).toBe(0);
  });

  test("enabled → POST chega no endpoint com payload sem PII", async () => {
    let received: { url: string; body: TelemetryPayload } | undefined;
    const fetchLike = (async (url: unknown, init?: RequestInit) => {
      received = {
        url: String(url),
        body: JSON.parse(String(init?.body)) as TelemetryPayload,
      };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const config = { enabled: true, endpoint: "http://telemetry.local/v1/runs", sampleRate: 1 };
    expect(await sendTelemetry(config, payload, fetchLike)).toBe(true);
    expect(received!.url).toBe("http://telemetry.local/v1/runs");
    expect(received!.body.runId).toBe("r1");
    expect(received!.body.model).toBe("openai/gpt-4o-mini");
    expect(received!.body.tokensIn).toBe(100);
    expect(received!.body.steps).toBe(2);
    // sem PII: nenhum campo de prompt/path/conteúdo
    const body = received!.body as unknown as Record<string, unknown>;
    expect(Object.keys(body).every((k) => !["prompt", "task", "path", "content", "file"].includes(k))).toBe(true);
  });

  test("endpoint fora do ar → false, sem exceção", async () => {
    const fetchLike = (async () => {
      throw new Error("conexão recusada");
    }) as unknown as typeof fetch;
    const config = { enabled: true, endpoint: "http://dead.local", sampleRate: 1 };
    expect(await sendTelemetry(config, payload, fetchLike)).toBe(false);
  });

  test("sampleRate 0 → nunca envia", async () => {
    const config = { enabled: true, endpoint: "http://x", sampleRate: 0 };
    expect(shouldSample(config)).toBe(false);
  });
});
