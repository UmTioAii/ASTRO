import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";
import { outboundUrlProblem, urlProblem } from "../src/url-safety";

function baseConfig(): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "https://api.example.com/v1", credentialRef: "P_KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 3, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("url-safety: hosts privados (#249)", () => {
  test("metadados e link-local são recusados mesmo com allowPrivate", () => {
    for (const raw of [
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]/",
      "http://metadata.google.internal/computeMetadata/v1",
    ]) {
      expect(urlProblem(raw)).toBeDefined();
      expect(outboundUrlProblem(raw, { allowPrivate: true })).toBeDefined();
    }
  });

  test("outbound recusa loopback e faixas privadas por padrão", () => {
    for (const raw of [
      "http://127.0.0.1:8080/x",
      "http://localhost/",
      "http://10.0.0.5/",
      "http://192.168.0.1/",
      "http://172.16.4.1/",
      "http://[::1]/",
      "http://[fc00::1]/",
    ]) {
      expect(outboundUrlProblem(raw, { allowPrivate: false })).toBeDefined();
    }
  });

  test("outbound aceita host público", () => {
    expect(outboundUrlProblem("https://api.example.com/v1", { allowPrivate: false })).toBeUndefined();
  });

  test("allowPrivate explícito libera loopback (dev local), nunca metadados", () => {
    expect(outboundUrlProblem("http://127.0.0.1:11434/v1", { allowPrivate: true })).toBeUndefined();
    expect(outboundUrlProblem("http://169.254.169.254/", { allowPrivate: true })).toBeDefined();
  });
});

describe("config: URLs de saída privadas (#249)", () => {
  test("provider baseUrl de metadados é recusado", () => {
    const raw = baseConfig();
    (raw.providers as Record<string, Record<string, unknown>>).p!.baseUrl = "http://169.254.169.254/v1";
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });

  test("MCP url de metadados é recusada", () => {
    const raw = baseConfig();
    raw.mcpServers = { api: { transport: "http", url: "http://169.254.169.254/mcp" } };
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });

  test("auditWebhook de metadados é recusado", () => {
    const raw = baseConfig();
    raw.team = { auditWebhook: "http://169.254.169.254/hook" };
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });

  test("telemetry.endpoint de metadados é recusado", () => {
    const raw = baseConfig();
    raw.telemetry = { enabled: true, endpoint: "http://169.254.169.254/v1/runs" };
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });
});
