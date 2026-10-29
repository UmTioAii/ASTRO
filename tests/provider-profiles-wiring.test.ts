import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveProfileStore } from "../src/provider/profiles";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { cwd: string; env: Record<string, string | undefined>; stdin?: string }): Promise<RunResult> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of ["ASTRO_PROVIDER", "ASTRO_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"]) {
    delete baseEnv[key];
  }
  const home = opts.env.ASTRO_HOME ?? mkdtempSync(join(tmpdir(), "astro-wire-home-"));
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ...opts.env, ASTRO_HOME: home } as Record<string, string>,
  });
  proc.stdin.write(opts.stdin ?? "");
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exit: await proc.exited, stdout, stderr };
}

const profile = {
  id: "openai-work",
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
};

function auditStarted(cwd: string): Record<string, unknown> {
  const text = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8");
  const line = text.split("\n").find((item) => item.includes('"run.started"'));
  if (line === undefined) throw new Error("run.started ausente");
  return JSON.parse(line) as Record<string, unknown>;
}

test("chat sem config usa o perfil global e audita a origem", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-"));
  const home = mkdtempSync(join(tmpdir(), "astro-wire-home-"));
  saveProfileStore({ version: 1, activeProfileId: "openai-work", profiles: [profile] }, join(home, "providers.json"));
  const result = await runCli(["chat", "--cwd", cwd], {
    cwd,
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(0);
  const started = auditStarted(cwd);
  expect((started.payload as Record<string, unknown>).providerSource).toBe("global");
  expect((started.payload as Record<string, unknown>).providerSelection).toBe("store");
});

test("primeiro turno sem config usa a baseline somente leitura", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { content: "ok da baseline" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "astro-wire-baseline-"));
    const home = mkdtempSync(join(tmpdir(), "astro-wire-baseline-home-"));
    const result = await runCli(["chat", "--cwd", cwd], {
      cwd,
      env: {
        ASTRO_HOME: home,
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "gpt-4o",
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      stdin: "oi\n/exit\n",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("ok da baseline");
    expect(result.stderr).toContain("somente leitura");
  } finally {
    server.stop(true);
  }
});

test("chat com OPENAI_* usa perfil efêmero sem criar store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-env-"));
  const home = mkdtempSync(join(tmpdir(), "astro-wire-env-home-"));
  const result = await runCli(["chat", "--cwd", cwd], {
    cwd,
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(0);
  const started = auditStarted(cwd);
  expect((started.payload as Record<string, unknown>).providerSource).toBe("env");
  expect((started.payload as Record<string, unknown>).providerSelection).toBe("env");
});

test("--config explícito ausente falha em vez de usar baseline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-missing-"));
  const result = await runCli(["chat", "--cwd", cwd, "--config", "nao-existe.json"], {
    cwd,
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/configuração não encontrada/);
});

test("run sem config falha", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-run-"));
  const result = await runCli(["run", "oi"], {
    cwd,
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/configuração não encontrada/);
});

test("--provider desconhecido falha", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-wire-provider-"));
  const result = await runCli(["chat", "--cwd", cwd, "--provider", "nao-existe"], {
    cwd,
    env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
    stdin: "/exit\n",
  });
  expect(result.exit).toBe(1);
  expect(result.stderr).toMatch(/provider "nao-existe" não está configurado/);
});
