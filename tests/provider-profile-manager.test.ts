import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, type AstroConfig } from "../src/config";
import { ProfileManager, type ProfileDraft } from "../src/provider/profile-manager";
import { loadProfileStore, saveProfileStore } from "../src/provider/profiles";

function project(): AstroConfig {
  return validateConfig({
    providers: {
      p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" },
    },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

const draft = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
  ...over,
});

function manager(home = mkdtempSync(join(tmpdir(), "astro-mgr-")), env: NodeJS.ProcessEnv = {}) {
  return {
    home,
    m: new ProfileManager({ project: project(), env: { ASTRO_HOME: home, ...env } }),
  };
}

const storeAt = (home: string) => loadProfileStore(join(home, "providers.json"));

test("add grava no store e não ativa", () => {
  const { home, m } = manager();
  const view = m.add(draft());
  expect(view.id).toBe("openai-work");
  expect(view.active).toBe(false);
  expect(view.source).toBe("global");
  const store = storeAt(home);
  expect(store.profiles.map((item) => item.id)).toEqual(["openai-work"]);
  expect(store.activeProfileId).toBeUndefined();
});

test("add rejeita nome duplicado", () => {
  const { m } = manager();
  m.add(draft());
  expect(() => m.add(draft({ baseUrl: "https://other.example/v1" })))
    .toThrow(/já existe um provider com esse nome/);
});

test("add rejeita nome de provider do projeto", () => {
  const { m } = manager();
  expect(() => m.add(draft({ name: "p" }))).toThrow(/astro\.config\.json/);
  expect(() => m.add(draft({ name: "P" }))).toThrow(/astro\.config\.json/);
});

test("add aceita provider sem chave", () => {
  const { home, m } = manager();
  const view = m.add(draft({ name: "Ollama", credentialRef: undefined, baseUrl: "http://localhost:11434/v1" }));
  expect(view.credentialRef).toBeUndefined();
  expect(storeAt(home).profiles[0]!.credentialRef).toBeUndefined();
});

test("edit mantém o id e atualiza os campos", () => {
  const { m } = manager();
  const added = m.add(draft());
  const edited = m.edit(added.id, draft({ name: "OpenAI Work 2", baseUrl: "https://proxy.example/v1" }));
  expect(edited.id).toBe(added.id);
  expect(edited.name).toBe("OpenAI Work 2");
  expect(edited.baseUrl).toBe("https://proxy.example/v1");
});

test("edit rejeita provider do projeto", () => {
  const { m } = manager();
  expect(() => m.edit("p", draft({ name: "p" }))).toThrow(/astro\.config\.json/);
});

test("remove apaga do store", () => {
  const { home, m } = manager();
  const added = m.add(draft());
  m.remove(added.id);
  expect(storeAt(home).profiles).toEqual([]);
});

test("remove do ativo limpa activeProfileId", () => {
  const { home, m } = manager();
  const added = m.add(draft());
  m.use(added.id);
  expect(storeAt(home).activeProfileId).toBe(added.id);
  m.remove(added.id);
  expect(storeAt(home).activeProfileId).toBeUndefined();
});

test("remove rejeita provider do projeto", () => {
  const { m } = manager();
  expect(() => m.remove("p")).toThrow(/astro\.config\.json/);
});

test("use persiste o ativo e rejeita projeto", () => {
  const { home, m } = manager();
  const added = m.add(draft());
  m.use(added.id);
  expect(storeAt(home).activeProfileId).toBe(added.id);
  expect(() => m.use("p")).toThrow(/astro\.config\.json/);
});

test("list mescla projeto, global e env com precedência do projeto", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-list-"));
  saveProfileStore({
    version: 1,
    activeProfileId: "openai-work",
    profiles: [
      {
        id: "openai-work",
        name: "OpenAI Work",
        kind: "openai-compat",
        baseUrl: "https://api.openai.com/v1",
        credentialRef: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
      },
      {
        id: "p",
        name: "p",
        kind: "openai-compat",
        baseUrl: "https://global-p.example/v1",
        credentialRef: "KEY",
        models: [{ id: "m1", tags: [], context: 1000 }],
      },
    ],
  }, join(home, "providers.json"));
  const m = new ProfileManager({
    project: project(),
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  const list = m.list();
  const p = list.find((item) => item.id === "p");
  expect(p?.source).toBe("project");
  expect(p?.baseUrl).toBe("https://p.example/v1");
  expect(list.find((item) => item.id === "openai-work")?.source).toBe("global");
  expect(list.find((item) => item.id === "openai-work")?.active).toBe(true);
  expect(list.find((item) => item.id === "env")?.source).toBe("env");
});

test("env não é gravado por add/edit", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-env-"));
  const m = new ProfileManager({
    project: project(),
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  expect(m.list().some((item) => item.id === "env")).toBe(true);
  m.add(draft());
  expect(existsSync(join(home, "providers.json"))).toBe(true);
  expect(storeAt(home).profiles.some((item) => item.id === "env")).toBe(false);
});
