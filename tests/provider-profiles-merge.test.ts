import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, type AstroConfig } from "../src/config";
import {
  loadEffectiveConfig,
  profileFromEnv,
  resolveEffectiveConfig,
  type ProviderProfile,
  type ProviderStore,
} from "../src/provider/profiles";

function project(provider = "p", model = "m1"): AstroConfig {
  return validateConfig({
    providers: {
      [provider]: { kind: "openai-compat", baseUrl: `https://${provider}.example/v1`, credentialRef: "KEY" },
    },
    models: [{ provider, id: model, tags: ["writing-code"], context: 8192 }],
    agent: { model: `${provider}/${model}`, maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: "openai-work",
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code", "tools"], context: 128000 }],
  ...over,
});

const store = (...profiles: ProviderProfile[]): ProviderStore => ({
  version: 1,
  ...(profiles[0] === undefined ? {} : { activeProfileId: profiles[0].id }),
  profiles,
});

test("--provider vence env, store e projeto", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "openai-work" })),
    providerFlag: "openai-work",
    env: { ASTRO_PROVIDER: "openai-work" },
  });
  expect(result.activeProvider).toBe("openai-work");
  expect(result.config.agent.model).toBe("openai-work/gpt-4o");
  expect(result.providerSource).toBe("global");
});

test("ASTRO_PROVIDER vence store e projeto", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "outro" }), profile()),
    env: { ASTRO_PROVIDER: "openai-work" },
  });
  expect(result.activeProvider).toBe("openai-work");
});

test("store.activeProfileId vence o projeto", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "openai-work" })),
    env: {},
  });
  expect(result.activeProvider).toBe("openai-work");
  expect(result.providerSource).toBe("global");
});

test("sem override, usa o provider do agent.model", () => {
  const result = resolveEffectiveConfig({ project: project(), store: store(), env: {} });
  expect(result.activeProvider).toBe("p");
  expect(result.providerSource).toBe("project");
  expect(result.config.agent.model).toBe("p/m1");
});

test("provider do projeto vence perfil global com o mesmo nome", () => {
  const result = resolveEffectiveConfig({
    project: project("same"),
    store: store(profile({ id: "same", baseUrl: "https://global.example/v1" })),
    env: {},
  });
  expect(result.config.providers.same?.baseUrl).toBe("https://same.example/v1");
  expect(result.providerSource).toBe("project");
});

test("modelos são unidos e o projeto vence no mesmo provider/id", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "p", models: [{ id: "m1", tags: ["fast"], context: 4096 }] })),
  });
  const keys = result.config.models.map((m) => `${m.provider}/${m.id}`).sort();
  expect(keys).toContain("p/m1");
  expect(result.config.models.find((m) => m.provider === "p" && m.id === "m1")?.context).toBe(8192);
});

test("ASTRO_PROVIDER desconhecido é erro", () => {
  expect(() => resolveEffectiveConfig({
    project: project(),
    store: store(),
    env: { ASTRO_PROVIDER: "nao-existe" },
  })).toThrow(/provider "nao-existe" não está configurado/);
});

test("activeProfileId inexistente avisa e cai no projeto", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: { version: 1, activeProfileId: "fantasma", profiles: [profile()] },
    env: {},
  });
  expect(result.activeProvider).toBe("p");
  expect(result.warnings.join(" ")).toMatch(/activeProfileId/);
});

test("profileFromEnv exige chave e modelo", () => {
  expect(profileFromEnv({})).toBeUndefined();
  expect(profileFromEnv({ OPENAI_API_KEY: "k" })).toBeUndefined();
  expect(profileFromEnv({ OPENAI_MODEL: "gpt-4o" })).toBeUndefined();
});

test("profileFromEnv monta o perfil efêmero", () => {
  const env = profileFromEnv({
    OPENAI_API_KEY: "k",
    OPENAI_MODEL: "gpt-4o",
    OPENAI_BASE_URL: "https://proxy.example/v1",
  });
  expect(env?.id).toBe("env");
  expect(env?.baseUrl).toBe("https://proxy.example/v1");
  expect(env?.models[0]?.id).toBe("gpt-4o");
});

test("sem projeto, um perfil global basta e avisa do baseline", () => {
  const result = resolveEffectiveConfig({ store: store(profile()), env: {} });
  expect(result.activeProvider).toBe("openai-work");
  expect(result.config.agent.model).toBe("openai-work/gpt-4o");
  expect(result.config.agent.maxSteps).toBe(12);
  expect(result.warnings.join(" ")).toMatch(/configuração padrão/);
});

test("env efêmero é usado sem escrever nada", () => {
  const envProfile = profileFromEnv({ OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" })!;
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(),
    envProfile,
    env: { ASTRO_PROVIDER: "env" },
  });
  expect(result.activeProvider).toBe("env");
  expect(result.providerSource).toBe("env");
  expect(result.config.agent.model).toBe("env/gpt-4o");
});

test("nada configurado é erro explicativo", () => {
  expect(() => resolveEffectiveConfig({ store: store(), env: {} }))
    .toThrow(/nenhum provider configurado/);
});

test("perfil sem chave entra no merge", () => {
  const result = resolveEffectiveConfig({
    store: store(profile({ id: "ollama", credentialRef: undefined, baseUrl: "http://localhost:11434/v1" })),
    env: {},
  });
  expect(result.config.providers.ollama).not.toHaveProperty("credentialRef");
});

test("agent.profile do projeto tem precedência sobre a troca", () => {
  const base = project();
  const pooled = validateConfig({
    providers: base.providers,
    models: base.models,
    agent: { profile: "fast", maxSteps: 2, tools: ["read_file"] },
    modelPool: { fast: { model: "p/m1" } },
    paths: base.paths,
  });
  const result = resolveEffectiveConfig({
    project: pooled,
    store: store(profile()),
    env: {},
  });
  expect(result.activeProvider).toBe("p");
  expect(result.warnings.join(" ")).toMatch(/agent\.profile/);
});

test("loadEffectiveConfig sem nada configurado lança erro", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-empty-"));
  expect(() => loadEffectiveConfig(join(home, "astro.config.json"), { env: { ASTRO_HOME: home } }))
    .toThrow(/nenhum provider configurado/);
});
