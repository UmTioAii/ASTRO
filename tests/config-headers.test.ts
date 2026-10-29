import { expect, test } from "bun:test";
import { validateConfig } from "../src/config";

function configWithHeaders(headers: Record<string, string>): unknown {
  return {
    providers: {
      p: {
        kind: "openai-compat",
        baseUrl: "https://p.example/v1",
        credentialRef: "KEY",
        headers,
      },
    },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

test("config aceita header de metadado", () => {
  const config = validateConfig(configWithHeaders({ "X-Title": "ASTRO" }));
  expect(config.providers.p).toMatchObject({ headers: { "X-Title": "ASTRO" } });
});

test("config rejeita headers de autenticação", () => {
  const cases: Array<Record<string, string>> = [
    { Authorization: "Bearer sk-live" },
    { "x-api-key": "sk-live" },
    { "x-goog-api-key": "sk-live" },
    { Cookie: "session=1" },
    { "X-Client-Secret": "sk-live" },
    { "X-Auth": "Bearer sk-live" },
  ];
  for (const headers of cases) {
    expect(() => validateConfig(configWithHeaders(headers))).toThrow(/header de autenticação/);
  }
});

test("config rejeita valor com cara de chave", () => {
  expect(() => validateConfig(configWithHeaders({ "X-Custom": "sk-live-do-not-store" })))
    .toThrow(/credencial/);
  expect(() => validateConfig(configWithHeaders({ "X-Custom": "Bearer sk-live-do-not-store" })))
    .toThrow(/credencial/);
});

test("config rejeita credencial embutida na baseUrl", () => {
  const raw = configWithHeaders({}) as Record<string, unknown>;
  const providers = raw.providers as Record<string, Record<string, unknown>>;
  expect(() => validateConfig({
    ...raw,
    providers: { p: { ...providers.p, baseUrl: "https://user:sk-live@proxy.example/v1" } },
  })).toThrow(/credencial/);
  expect(() => validateConfig({
    ...raw,
    providers: { p: { ...providers.p, baseUrl: "https://proxy.example/v1?api_key=sk-live" } },
  })).toThrow(/credencial/);
});
