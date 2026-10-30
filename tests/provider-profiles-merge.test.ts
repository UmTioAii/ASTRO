import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, type AstroConfig } from "../src/config";
import {
  loadEffectiveConfig,
  profileFromEnv,
  providerIdentityFor,
  resolveEffectiveConfig,
  saveProfileStore,
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
  expect(result.providerSelection).toBe("flag");
});

test("ASTRO_PROVIDER vence store e projeto", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "outro" }), profile()),
    env: { ASTRO_PROVIDER: "openai-work" },
  });
  expect(result.activeProvider).toBe("openai-work");
  expect(result.providerSelection).toBe("env");
});

test("store.activeProfileId vence o projeto", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "openai-work" })),
    env: {},
  });
  expect(result.activeProvider).toBe("openai-work");
  expect(result.providerSource).toBe("global");
  expect(result.providerSelection).toBe("store");
});

test("sem override, usa o provider do agent.model", () => {
  const result = resolveEffectiveConfig({ project: project(), store: store(), env: {} });
  expect(result.activeProvider).toBe("p");
  expect(result.providerSource).toBe("project");
  expect(result.providerSelection).toBe("project");
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
  expect(result.providerSelection).toBe("store");
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

test("sem projeto, um perfil global basta e usa baseline somente leitura", () => {
  const result = resolveEffectiveConfig({ store: store(profile()), env: {} });
  expect(result.activeProvider).toBe("openai-work");
  expect(result.config.agent.model).toBe("openai-work/gpt-4o");
  expect(result.config.agent.maxSteps).toBe(12);
  expect(result.config.agent.tools).toEqual(["read_file", "list_dir", "grep"]);
  expect(result.config.tools?.run_command).toBeUndefined();
  expect(result.providerSelection).toBe("store");
  expect(result.warnings.join(" ")).toMatch(/somente leitura/);
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
  expect(result.providerSelection).toBe("env");
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

test("agent.profile não avisa quando o provider pedido é o do projeto", () => {
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
    store: store(profile({ id: "p", name: "P", models: [{ id: "m1", tags: [], context: 1000 }] })),
    env: {},
  });
  expect(result.activeProvider).toBe("p");
  expect(result.warnings.join(" ")).not.toMatch(/agent\.profile/);
  expect(result.providerSelection).toBe("project");
});

test("loadEffectiveConfig sem nada configurado lança erro", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-empty-"));
  expect(() => loadEffectiveConfig(join(home, "astro.config.json"), { env: { ASTRO_HOME: home }, allowMissing: true }))
    .toThrow(/nenhum provider configurado/);
});

test("loadEffectiveConfig não tolera config explícita ausente", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-missing-"));
  expect(() => loadEffectiveConfig(join(home, "typo.json"), { env: { ASTRO_HOME: home } }))
    .toThrow(/configuração não encontrada/);
});

test("loadEffectiveConfig com projeto e store no disco", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-happy-"));
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const home = join(dir, "home");
  const result = loadEffectiveConfig(configPath, {
    env: { ASTRO_HOME: home },
    storePath: join(home, "providers.json"),
  });
  expect(result.activeProvider).toBe("p");
  expect(result.config.agent.model).toBe("p/m1");
});

test("perfil efêmero não cria arquivo nem grava a chave", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-env-"));
  const key = "sk-test-do-not-store";
  const result = loadEffectiveConfig(join(home, "astro.config.json"), {
    env: { ASTRO_HOME: home, OPENAI_API_KEY: key, OPENAI_MODEL: "gpt-4o" },
    allowMissing: true,
  });
  expect(result.activeProvider).toBe("env");
  expect(readdirSync(home)).toEqual([]);
  const leaked = readdirSync(home).some((name) => readFileSync(join(home, name), "utf8").includes(key));
  expect(leaked).toBe(false);
});

test("OPENAI_BASE_URL com credencial é rejeitada", () => {
  expect(() => profileFromEnv({
    OPENAI_API_KEY: "k",
    OPENAI_MODEL: "gpt-4o",
    OPENAI_BASE_URL: "https://user:sk-live@proxy.example/v1",
  })).toThrow(/credencial/);
});

test("perfil salvo com id env colide e avisa", () => {
  const envProfile = profileFromEnv({ OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" })!;
  const result = resolveEffectiveConfig({
    store: store(profile({ id: "env", name: "Env salvo" })),
    envProfile,
    env: {},
  });
  expect(result.warnings.join(" ")).toMatch(/env.*ignorado/);
});

test("agents nomeados com profile sobrevivem à revalidação", () => {
  const base = project();
  const withAgents = validateConfig({
    ...base,
    providers: {
      ...base.providers,
      backup: { kind: "openai-compat", baseUrl: "https://backup.example/v1", credentialRef: "BACKUP_KEY" },
    },
    modelPool: { fast: { model: "p/m1" } },
    agents: { coder: { profile: "fast" } },
  });
  const result = resolveEffectiveConfig({
    project: withAgents,
    store: store(profile()),
    env: {},
  });
  expect(result.config.agents?.coder?.model).toBe("p/m1");
  expect(result.config.agents?.coder?.profile).toBe("fast");
});

test("ignoreStoredSelection mantém o provider do projeto (resume/replay)", () => {
  const result = resolveEffectiveConfig({
    project: project(),
    store: store(profile()),
    ignoreStoredSelection: true,
    env: {},
  });
  expect(result.activeProvider).toBe("p");
  expect(result.providerSelection).toBe("project");
});

test("--provider em projeto com agent.profile é erro explícito", () => {
  const base = project();
  const pooled = validateConfig({
    providers: base.providers,
    models: base.models,
    agent: { profile: "fast", maxSteps: 2, tools: ["read_file"] },
    modelPool: { fast: { model: "p/m1" } },
    paths: base.paths,
  });
  expect(() => resolveEffectiveConfig({
    project: pooled,
    store: store(profile({ id: "q", name: "Q", models: [{ id: "m2", tags: [], context: 1000 }] })),
    providerFlag: "q",
    env: {},
  })).toThrow(/agent\.profile tem precedência/);
});

test("origem de provider não ativo reflete o store, não o projeto", () => {
  const effective = resolveEffectiveConfig({
    project: project(),
    store: store(profile({ id: "x", name: "X" }), profile({ id: "y", name: "Y" })),
    env: {},
  });
  expect(effective.activeProvider).toBe("x");
  const fromStore = providerIdentityFor(effective, "y");
  expect(fromStore.providerSource).toBe("global");
  expect(fromStore.providerSelection).toBe("store");
  const fromProject = providerIdentityFor(effective, "p");
  expect(fromProject.providerSource).toBe("project");
  expect(fromProject.providerSelection).toBe("project");
});

test("--provider desconhecido é erro", () => {
  expect(() => resolveEffectiveConfig({
    project: project(),
    store: store(),
    providerFlag: "nao-existe",
    env: {},
  })).toThrow(/não está configurado/);
});

test("modelo disabled não é escolhido", () => {
  const base = project();
  const withQ = validateConfig({
    ...base,
    providers: {
      ...base.providers,
      q: { kind: "openai-compat", baseUrl: "https://q.example/v1", credentialRef: "KEY" },
    },
    models: [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "old", tags: [], context: 1000, status: "disabled" },
      { provider: "q", id: "new", tags: [], context: 1000 },
    ],
    agent: { ...base.agent, model: "p/m1" },
  });
  const result = resolveEffectiveConfig({
    project: withQ,
    store: store(),
    providerFlag: "q",
    env: {},
  });
  expect(result.config.agent.model).toBe("q/new");
});

test("activeProfileId órfão no disco avisa e cai no projeto", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-orphan-"));
  const home = join(dir, "home");
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const storePath = join(home, "providers.json");
  saveProfileStore({
    version: 1,
    activeProfileId: "fantasma",
    profiles: [profile()],
  }, storePath);
  const result = loadEffectiveConfig(configPath, { env: { ASTRO_HOME: home } });
  expect(result.activeProvider).toBe("p");
  expect(result.providerSelection).toBe("project");
  expect(result.warnings.join(" ")).toMatch(/activeProfileId/);
});
