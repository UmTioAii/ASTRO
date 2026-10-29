import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../src/app";
import { validateConfig, type AstroConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { OpenAICompatProvider } from "../src/provider/openai-compat";
import { Registry } from "../src/registry";

function configFor(provider: Record<string, unknown>): AstroConfig {
  return validateConfig({
    providers: { local: provider },
    models: [{ provider: "local", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "local/m1", maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

const modelOf = (config: AstroConfig) => new Registry(config).require("local/m1");

test("config aceita openai-compat sem credentialRef", () => {
  const config = configFor({ kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1" });
  expect(config.providers.local).not.toHaveProperty("credentialRef");
});

test("createProvider sem chave não exige env", () => {
  const config = configFor({ kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1" });
  const setup = createProvider(config, modelOf(config), {});
  expect(setup.credentialRef).toBeUndefined();
});

test("provider sem chave não envia authorization", async () => {
  const seen = { value: "sentinel" as string | null };
  const fetchFn = async (_url: string, init?: RequestInit) => {
    seen.value = new Headers(init?.headers).get("authorization");
    return Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  const provider = new OpenAICompatProvider({ baseUrl: "http://x/v1", fetchFn });
  const result = await provider.complete({ model: "m1", messages: [{ role: "user", content: "oi" }] });
  expect(result.content).toBe("ok");
  expect(seen.value).toBeNull();
});

test("provider com chave continua enviando authorization", async () => {
  const seen = { value: null as string | null };
  const fetchFn = async (_url: string, init?: RequestInit) => {
    seen.value = new Headers(init?.headers).get("authorization");
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
  };
  const provider = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn });
  await provider.complete({ model: "m1", messages: [{ role: "user", content: "oi" }] });
  expect(seen.value).toBe("Bearer k");
});

test("credentialRef sem a variável no ambiente continua erro", () => {
  const config = configFor({
    kind: "openai-compat",
    baseUrl: "http://127.0.0.1:1/v1",
    credentialRef: "KEY",
  });
  expect(() => createProvider(config, modelOf(config), {})).toThrow(/defina KEY no ambiente/);
});

test("ledger aceita entrada sem credentialRef", () => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-keyless-")), "ledger.jsonl");
  const ledger = new Ledger(path);
  ledger.record({
    run: "r",
    agent: "a",
    provider: "local",
    model: "m1",
    quotaDomain: "default",
    tokensIn: 1,
    tokensOut: 1,
  });
  expect(ledger.readAll()[0]).not.toHaveProperty("credentialRef");
});
