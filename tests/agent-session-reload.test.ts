import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/chat/agent-session";
import { saveProfileStore } from "../src/provider/profiles";

test("reload troca o provider sem perder mensagens e cai no projeto se o ativo sumir", () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-reload-"));
  const home = mkdtempSync(join(tmpdir(), "astro-reload-home-"));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const session = new AgentSession({ configPath, cwd, env: { ASTRO_HOME: home } });
  expect(session.model).toBe("p/m1");

  saveProfileStore({
    version: 1,
    activeProfileId: "q",
    profiles: [{
      id: "q", name: "Q", kind: "openai-compat",
      baseUrl: "https://q.example/v1", credentialRef: "KEY",
      models: [{ id: "m2", tags: ["writing-code"], context: 8192 }],
    }],
  }, join(home, "providers.json"));
  session.reload(true);
  expect(session.model).toBe("q/m2");
  expect(session.messages.length).toBe(1);
  expect(session.providerSource).toBe("global");
  expect(session.providerSelection).toBe("store");

  saveProfileStore({ version: 1, profiles: [] }, join(home, "providers.json"));
  session.reload(true);
  expect(session.model).toBe("p/m1");
  expect(session.messages.length).toBe(1);
});
