import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/chat/agent-session";
import { ProfileManager } from "../src/provider/profile-manager";
import { NoProviderError, resolveEffectiveConfig } from "../src/provider/profiles";
import { withProviderSetup } from "../src/tui/run";

test("config vazia sem env lança NoProviderError", () => {
  expect(() => resolveEffectiveConfig({
    store: { version: 1, profiles: [] },
    env: {},
  })).toThrow(NoProviderError);
});

test("sessão criada não abre o setup", async () => {
  let setups = 0;
  const session = await withProviderSetup(
    () => ({ ok: true }),
    async () => { setups++; return true; },
    true,
  );
  expect(session).toEqual({ ok: true });
  expect(setups).toBe(0);
});

test("sem provider e config implícita abre o setup e recria a sessão", async () => {
  let creates = 0;
  let setups = 0;
  const session = await withProviderSetup(
    () => {
      creates++;
      if (creates === 1) throw new NoProviderError("nenhum provider");
      return "session";
    },
    async () => { setups++; return true; },
    true,
  );
  expect(session).toBe("session");
  expect(creates).toBe(2);
  expect(setups).toBe(1);
});

test("sem provider com config explícita não abre o setup", async () => {
  let setups = 0;
  await expect(withProviderSetup(
    () => { throw new NoProviderError("nenhum provider"); },
    async () => { setups++; return true; },
    false,
  )).rejects.toBeInstanceOf(NoProviderError);
  expect(setups).toBe(0);
});

test("setup cancelado retorna undefined", async () => {
  const session = await withProviderSetup(
    () => { throw new NoProviderError("nenhum provider"); },
    async () => false,
    true,
  );
  expect(session).toBeUndefined();
});

test("outro erro não abre o setup", async () => {
  let setups = 0;
  await expect(withProviderSetup(
    () => { throw new Error("boom"); },
    async () => { setups++; return true; },
    true,
  )).rejects.toThrow("boom");
  expect(setups).toBe(0);
});

test("perfil adicionado e ativado permite abrir a sessão", () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-first-run-"));
  const env = { ASTRO_HOME: join(cwd, "home"), LOCAL_KEY: "x" };
  const manager = new ProfileManager({ project: undefined, env });
  manager.add({
    name: "local",
    kind: "openai-compat",
    baseUrl: "http://127.0.0.1:1/v1",
    credentialRef: "LOCAL_KEY",
    models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
  });
  manager.use("local");

  const session = new AgentSession({
    configPath: join(cwd, "astro.config.json"),
    cwd,
    env,
    allowMissingConfig: true,
  });
  try {
    expect(session.model).toBe("local/m1");
  } finally {
    session.close();
  }
});
