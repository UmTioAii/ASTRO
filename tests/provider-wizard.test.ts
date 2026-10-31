import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { runProviderWizard } from "../src/chat/provider-wizard";
import { ProfileManager } from "../src/provider/profile-manager";
import { loadProfileStore } from "../src/provider/profiles";

function project() {
  return validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "astro-wizard-"));
  const manager = new ProfileManager({ project: project(), env: { ASTRO_HOME: home, ...env } });
  return { home, manager };
}

function fakeIO(answers: string[]) {
  const out: string[] = [];
  let index = 0;
  return {
    out,
    io: {
      read: async () => answers[index++] ?? null,
      write: (text: string) => { out.push(text); },
    },
  };
}

test("add pelo catálogo grava, ativa e chama onUse", async () => {
  const { home, manager } = setup();
  const used: string[] = [];
  const { io, out } = fakeIO(["openai", "OpenAI Work", "", "", "", "S", "S"]);
  const view = await runProviderWizard(io, manager, { mode: "add", onUse: (id) => used.push(id) });
  expect(view?.id).toBe("openai-work");
  expect(used).toEqual(["openai-work"]);
  const store = loadProfileStore(join(home, "providers.json"));
  expect(store.activeProfileId).toBe("openai-work");
  expect(store.profiles[0]!.baseUrl).toBe("https://api.openai.com/v1");
  expect(out.join(" ")).toContain("salvo: openai-work");
});

test("add pelo catálogo persiste o quotaDomain da entrada", async () => {
  const { manager } = setup();
  const { io } = fakeIO(["openai", "OpenAI Work", "", "", "", "S", "n"]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(manager.list().find((item) => item.id === "openai-work")?.quotaDomain).toBe("openai");
});

test("add custom sem chave e sem ativar", async () => {
  const { home, manager } = setup();
  const { io } = fakeIO(["custom", "Ollama", "http://localhost:11434/v1", "", "llama3.1", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view?.credentialRef).toBeUndefined();
  expect(view?.baseUrl).toBe("http://localhost:11434/v1");
  expect(loadProfileStore(join(home, "providers.json")).activeProfileId).toBeUndefined();
});

test("avisa quando a variável da chave não existe", async () => {
  const { manager } = setup();
  const { io, out } = fakeIO(["custom", "Local", "http://localhost:1/v1", "MISSING_KEY", "m1", "S", "n"]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(out.join(" ")).toContain("MISSING_KEY não encontrada");
});

test("cancelar no confirmar não grava", async () => {
  const { home, manager } = setup();
  const { io } = fakeIO(["custom", "X", "http://x/v1", "", "m1", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view).toBeUndefined();
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("edit mantém o id e atualiza a baseUrl", async () => {
  const { manager } = setup();
  const added = manager.add({
    name: "OpenAI Work",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    credentialRef: "OPENAI_API_KEY",
    models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
  });
  const { io } = fakeIO(["OpenAI Work 2", "https://proxy.example/v1", "", "", "S"]);
  const view = await runProviderWizard(io, manager, { mode: "edit", profile: added });
  expect(view?.id).toBe(added.id);
  expect(view?.name).toBe("OpenAI Work 2");
  expect(view?.baseUrl).toBe("https://proxy.example/v1");
});

test("modelos vazios não salvam", async () => {
  const { manager } = setup();
  const { io, out } = fakeIO(["custom", "X", "http://x/v1", "", " ; "]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(out.join(" ")).toContain("ao menos um modelo");
});

test("credentialRef inválido é re-perguntado até virar nome de variável válido (#286)", async () => {
  const { manager } = setup({ MINHA_CHAVE: "x" });
  const { io, out } = fakeIO(["custom", "Local", "http://localhost:1/v1", "minha chave", "MINHA_CHAVE", "m1", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view?.credentialRef).toBe("MINHA_CHAVE");
  expect(out.join(" ")).toContain("nome de variável inválido");
});

test("credentialRef vazio continua sem chave (#286)", async () => {
  const { manager } = setup();
  const { io } = fakeIO(["custom", "Local", "http://localhost:1/v1", "", "m1", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view?.credentialRef).toBeUndefined();
});
