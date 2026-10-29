import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfileStore } from "../src/provider/profiles";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function projectConfig(cwd: string): string {
  const path = join(cwd, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: {
      p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" },
      q: { kind: "openai-compat", baseUrl: "http://127.0.0.1:2/v1", credentialRef: "KEY" },
    },
    models: [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m2", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return path;
}

async function chat(cwd: string, cfg: string, home: string, stdin: string) {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of ["ASTRO_PROVIDER", "ASTRO_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"]) {
    delete baseEnv[key];
  }
  const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--cwd", cwd, "--config", cfg], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ASTRO_HOME: home } as Record<string, string>,
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exit: await proc.exited, stdout, stderr };
}

test("/provider add grava, ativa e aparece na lista", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-repl-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-repl-home-"));
  const cfg = projectConfig(cwd);
  const add = await chat(
    cwd, cfg, home,
    "/provider add\ncustom\nLocal\nhttp://localhost:11434/v1\n\nllama3.1\nS\nS\n/exit\n",
  );
  expect(add.exit).toBe(0);
  expect(add.stdout).toContain("salvo: local");
  expect(add.stdout).toContain("provider ativo: local");
  const store = loadProfileStore(join(home, "providers.json"));
  expect(store.profiles.map((item) => item.id)).toEqual(["local"]);
  expect(store.activeProfileId).toBe("local");

  const list = await chat(cwd, cfg, home, "/provider\n/exit\n");
  expect(list.exit).toBe(0);
  expect(list.stdout).toContain("Local (local)");
});

test("/provider remove apaga o perfil", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-rm-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-rm-home-"));
  const cfg = projectConfig(cwd);
  await chat(cwd, cfg, home, "/provider add\ncustom\nLocal\nhttp://localhost:1/v1\n\nm1\nS\nn\n/exit\n");
  const removed = await chat(cwd, cfg, home, "/provider remove local\n/exit\n");
  expect(removed.exit).toBe(0);
  expect(removed.stdout).toContain("removido: local");
  expect(loadProfileStore(join(home, "providers.json")).profiles).toEqual([]);
});

test("/provider <nome> troca para provider do projeto sem persistir", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-switch-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-switch-home-"));
  const cfg = projectConfig(cwd);
  const result = await chat(cwd, cfg, home, "/provider q\n/exit\n");
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("provider: q/m2");
  expect(result.stdout).toContain("definido no projeto; não persistido");
});

test("ativar um add em projeto com agent.profile avisa e não derruba o REPL", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-pool-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-pool-home-"));
  const cfg = join(cwd, "astro.config.json");
  writeFileSync(cfg, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    modelPool: { fast: { model: "p/m1" } },
    agent: { profile: "fast", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const result = await chat(
    cwd, cfg, home,
    "/provider add\ncustom\nLocal\nhttp://localhost:1/v1\n\nm1\nS\nS\n/exit\n",
  );
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("agent.profile tem precedência");
  expect(loadProfileStore(join(home, "providers.json")).profiles.map((item) => item.id)).toEqual(["local"]);
});

test("/provider remove de provider do projeto é recusado", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-provider-guard-"));
  const home = mkdtempSync(join(tmpdir(), "astro-provider-guard-home-"));
  const cfg = projectConfig(cwd);
  const result = await chat(cwd, cfg, home, "/provider remove p\n/exit\n");
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("astro.config.json");
});
