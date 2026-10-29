import { expect, test } from "bun:test";
import { PROVIDER_CATALOG, catalogEntry } from "../src/provider/catalog";
import { validateProfileStore } from "../src/provider/profiles";

const asProfile = (entry: (typeof PROVIDER_CATALOG)[number]) => ({
  id: entry.key,
  name: entry.name,
  kind: entry.kind,
  ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
  ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
  ...(entry.credentialsPath === undefined ? {} : { credentialsPath: entry.credentialsPath }),
  models: entry.models,
});

test("catálogo tem as cinco entradas esperadas", () => {
  expect(PROVIDER_CATALOG.map((entry) => entry.key)).toEqual([
    "openai", "openrouter", "nvidia", "ollama", "codex",
  ]);
});

test("cada entrada é um perfil válido", () => {
  for (const entry of PROVIDER_CATALOG) {
    const store = validateProfileStore({ version: 1, profiles: [asProfile(entry)] });
    expect(store.profiles[0]!.models.length).toBeGreaterThan(0);
  }
});

test("entradas têm modelos com contexto positivo", () => {
  for (const entry of PROVIDER_CATALOG) {
    for (const model of entry.models) {
      expect(model.context).toBeGreaterThan(0);
    }
  }
});

test("ollama é local e sem chave", () => {
  const ollama = catalogEntry("ollama");
  expect(ollama?.baseUrl).toBe("http://localhost:11434/v1");
  expect(ollama?.credentialRef).toBeUndefined();
});

test("codex usa credentialsPath e nenhuma chave", () => {
  const codex = catalogEntry("codex");
  expect(codex?.credentialsPath).toBe("~/.codex/auth.json");
  expect(codex?.credentialRef).toBeUndefined();
});

test("buscas por chave inexistente retornam undefined", () => {
  expect(catalogEntry("nao-existe")).toBeUndefined();
});
