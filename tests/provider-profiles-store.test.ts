import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfileStore, profilesPath, saveProfileStore } from "../src/provider/profiles";

const profile = {
  id: "openai-work",
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
};

const tempHome = (): string => mkdtempSync(join(tmpdir(), "astro-profiles-"));

test("ASTRO_HOME define o caminho do store", () => {
  const home = tempHome();
  expect(profilesPath({ ASTRO_HOME: home })).toBe(join(home, "providers.json"));
});

test("sem ASTRO_HOME usa ~/.astro/providers.json", () => {
  expect(profilesPath({})).toBe(join(homedir(), ".astro", "providers.json"));
});

test("store ausente começa vazio", () => {
  const store = loadProfileStore(join(tempHome(), "providers.json"));
  expect(store).toEqual({ version: 1, profiles: [] });
});

test("roundtrip preserva perfis e o ativo", () => {
  const path = join(tempHome(), "providers.json");
  saveProfileStore({ version: 1, activeProfileId: "openai-work", profiles: [profile] }, path);
  const loaded = loadProfileStore(path);
  expect(loaded.activeProfileId).toBe("openai-work");
  expect(loaded.profiles[0]).toEqual(profile);
});

test("save cria o diretório pai", () => {
  const path = join(tempHome(), "nested", "dir", "providers.json");
  saveProfileStore({ version: 1, profiles: [profile] }, path);
  expect(existsSync(path)).toBe(true);
});

test("save não deixa arquivo temporário", () => {
  const path = join(tempHome(), "providers.json");
  saveProfileStore({ version: 1, profiles: [profile] }, path);
  expect(existsSync(`${path}.tmp`)).toBe(false);
});

test("JSON corrompido falha citando o caminho", () => {
  const path = join(tempHome(), "providers.json");
  writeFileSync(path, "{ nao é json");
  expect(() => loadProfileStore(path)).toThrow(/inválido/);
  expect(() => loadProfileStore(path)).toThrow(/providers\.json/);
  expect(readFileSync(path, "utf8")).toBe("{ nao é json");
});

test("store inválido não é gravado", () => {
  const path = join(tempHome(), "providers.json");
  expect(() => saveProfileStore({ version: 1, profiles: [{ ...profile, apiKey: "sk-x" }] } as never, path))
    .toThrow(/apiKey/);
  expect(existsSync(path)).toBe(false);
});

test("modo 0600 no POSIX", () => {
  if (process.platform === "win32") return;
  const path = join(tempHome(), "providers.json");
  saveProfileStore({ version: 1, profiles: [profile] }, path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("arquivo vazio é um store vazio", () => {
  const path = join(tempHome(), "providers.json");
  writeFileSync(path, "   \n");
  expect(loadProfileStore(path)).toEqual({ version: 1, profiles: [] });
});

test("erro de JSON não ecoa o conteúdo colado", () => {
  const path = join(tempHome(), "providers.json");
  writeFileSync(path, '{ "apiKey": "sk-secret-fragment"');
  const call = () => loadProfileStore(path);
  expect(call).toThrow(/JSON inválido/);
  expect(call).not.toThrow(/sk-secret/);
  expect(call).not.toThrow(/Unexpected|JSON Parse/);
});

test("segundo save sobrescreve o store", () => {
  const path = join(tempHome(), "providers.json");
  saveProfileStore({ version: 1, profiles: [profile] }, path);
  saveProfileStore({
    version: 1,
    activeProfileId: "outro",
    profiles: [{ ...profile, id: "outro", name: "Outro" }],
  }, path);
  const loaded = loadProfileStore(path);
  expect(loaded.profiles.map((item) => item.id)).toEqual(["outro"]);
  expect(loaded.activeProfileId).toBe("outro");
});

test("tmp pré-existente não é reutilizado", () => {
  const path = join(tempHome(), "providers.json");
  writeFileSync(`${path}.tmp`, "preservar");
  saveProfileStore({ version: 1, profiles: [profile] }, path);
  expect(readFileSync(`${path}.tmp`, "utf8")).toBe("preservar");
});
