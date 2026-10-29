import { expect, test } from "bun:test";
import { validateProfileStore } from "../src/provider/profiles";

const baseProfile = {
  id: "openai-work",
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code", "tools"], context: 128000 }],
};

const storeWith = (profile: unknown): unknown => ({ version: 1, profiles: [profile] });

test("aceita um store mínimo válido", () => {
  const store = validateProfileStore(storeWith(baseProfile));
  expect(store.version).toBe(1);
  expect(store.profiles).toHaveLength(1);
  expect(store.profiles[0]!.id).toBe("openai-work");
  expect(store.profiles[0]!.models[0]!.context).toBe(128000);
});

test("aceita store vazio", () => {
  expect(validateProfileStore({ version: 1, profiles: [] }).profiles).toEqual([]);
});

test("rejeita versão desconhecida", () => {
  expect(() => validateProfileStore({ version: 2, profiles: [] })).toThrow(/version/);
});

test("rejeita campo desconhecido no perfil (apiKey colado)", () => {
  expect(() => validateProfileStore(storeWith({ ...baseProfile, apiKey: "sk-x" })))
    .toThrow(/profiles\[0\]\.apiKey/);
});

test("rejeita campo desconhecido no root", () => {
  expect(() => validateProfileStore({ version: 1, profiles: [], apiKey: "sk-x" }))
    .toThrow(/apiKey/);
});

test("rejeita header de autenticação", () => {
  expect(() => validateProfileStore(storeWith({
    ...baseProfile,
    headers: { Authorization: "Bearer sk-x" },
  }))).toThrow(/authorization/);
  expect(() => validateProfileStore(storeWith({
    ...baseProfile,
    headers: { "x-api-key": "sk-x" },
  }))).toThrow(/x-api-key/);
});

test("aceita header não autenticado", () => {
  const store = validateProfileStore(storeWith({ ...baseProfile, headers: { "X-Title": "ASTRO" } }));
  expect(store.profiles[0]!.headers).toEqual({ "X-Title": "ASTRO" });
});

test("rejeita credentialRef que não é nome de variável", () => {
  expect(() => validateProfileStore(storeWith({ ...baseProfile, credentialRef: "openai key" })))
    .toThrow(/credentialRef/);
  expect(() => validateProfileStore(storeWith({ ...baseProfile, credentialRef: "sk-abc" })))
    .toThrow(/credentialRef/);
});

test("rejeita id duplicado", () => {
  expect(() => validateProfileStore({
    version: 1,
    profiles: [baseProfile, { ...baseProfile, name: "Outro" }],
  })).toThrow(/duplicado/);
});

test("rejeita nome duplicado", () => {
  expect(() => validateProfileStore({
    version: 1,
    profiles: [baseProfile, { ...baseProfile, id: "outro" }],
  })).toThrow(/duplicado/);
});

test("rejeita tag fora do vocabulário", () => {
  expect(() => validateProfileStore(storeWith({
    ...baseProfile,
    models: [{ id: "gpt-4o", tags: ["frontend"], context: 128000 }],
  }))).toThrow(/tag "frontend"/);
});

test("rejeita perfil sem modelos", () => {
  expect(() => validateProfileStore(storeWith({ ...baseProfile, models: [] })))
    .toThrow(/models/);
});

test("rejeita contexto não positivo", () => {
  expect(() => validateProfileStore(storeWith({
    ...baseProfile,
    models: [{ id: "gpt-4o", tags: [], context: 0 }],
  }))).toThrow(/context/);
});

test("rejeita openai-compat sem baseUrl", () => {
  const { baseUrl: _baseUrl, ...semBase } = baseProfile;
  expect(() => validateProfileStore(storeWith(semBase))).toThrow(/baseUrl/);
});

test("rejeita codex-oauth sem credentialsPath", () => {
  expect(() => validateProfileStore(storeWith({
    id: "codex",
    name: "Codex",
    kind: "codex-oauth",
    models: [{ id: "gpt-5.5", tags: ["tools"], context: 400000 }],
  }))).toThrow(/credentialsPath/);
});

test("aceita openai-compat sem chave (provider local)", () => {
  const { credentialRef: _ref, ...semChave } = baseProfile;
  const store = validateProfileStore(storeWith(semChave));
  expect(store.profiles[0]!.credentialRef).toBeUndefined();
});

test("rejeita activeProfileId que não existe", () => {
  expect(() => validateProfileStore({
    version: 1,
    activeProfileId: "fantasma",
    profiles: [baseProfile],
  })).toThrow(/activeProfileId/);
});

test("aceita activeProfileId existente", () => {
  const store = validateProfileStore({ version: 1, activeProfileId: "openai-work", profiles: [baseProfile] });
  expect(store.activeProfileId).toBe("openai-work");
});

test("rejeita perfil que não é objeto", () => {
  expect(() => validateProfileStore({ version: 1, profiles: ["x"] })).toThrow(/profiles\[0\]/);
});

test("rejeita id que não é slug", () => {
  expect(() => validateProfileStore(storeWith({ ...baseProfile, id: "OpenAI Work" })))
    .toThrow(/slug/);
  expect(() => validateProfileStore(storeWith({ ...baseProfile, id: "../../etc/passwd" })))
    .toThrow(/slug/);
});

test("rejeita nome duplicado ignorando maiúsculas", () => {
  expect(() => validateProfileStore({
    version: 1,
    profiles: [baseProfile, { ...baseProfile, id: "outro", name: "openai work" }],
  })).toThrow(/duplicado/);
});

test("rejeita modelo duplicado no mesmo perfil", () => {
  expect(() => validateProfileStore(storeWith({
    ...baseProfile,
    models: [
      { id: "gpt-4o", tags: [], context: 1000 },
      { id: "gpt-4o", tags: [], context: 2000 },
    ],
  }))).toThrow(/modelo duplicado/);
});

test("rejeita baseUrl que não é http(s)", () => {
  expect(() => validateProfileStore(storeWith({ ...baseProfile, baseUrl: "http//localhost:11434/v1" })))
    .toThrow(/URL http\(s\)/);
  expect(() => validateProfileStore(storeWith({ ...baseProfile, baseUrl: "ftp://example/v1" })))
    .toThrow(/URL http\(s\)/);
});

test("rejeita headers de credencial menos óbvios", () => {
  for (const headers of [
    { "x-goog-api-key": "AIza" },
    { "Proxy-Authorization": "x" },
    { Cookie: "session=1" },
    { "x-amz-security-token": "x" },
  ]) {
    expect(() => validateProfileStore(storeWith({ ...baseProfile, headers })))
      .toThrow(/header de autenticação/);
  }
});
