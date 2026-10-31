import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Provider mock: 1ª chamada pede write_file, 2ª responde texto final. */
function mockServer() {
  let call = 0;
  return Bun.serve({
    port: 0,
    fetch: async () => {
      call++;
      return Response.json(call % 2 === 1
        ? {
            choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "saida.txt", content: "ok" }) } }] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
        : { choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
}

function project(port: number, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "astro-mode-flag-"));
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096 }],
    agent: { model: "mock/mock-1", maxSteps: 4, tools: ["write_file"] },
    permissions: { mode },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { dir, configPath };
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  return {
    exit,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

/** Um run completo com servidor novo (o mock é stateful por chamada). */
async function run(mode: string, extra: string[]) {
  const server = mockServer();
  try {
    const { dir, configPath } = project(server.port!, mode);
    const result = await runCli(["run", "escreva", "--config", configPath, "--cwd", dir, ...extra], { TEST_KEY: "k" });
    return { ...result, dir };
  } finally {
    server.stop(true);
  }
}

test("--permission-mode bypass sobrepõe permissions.mode ask (#269)", async () => {
  // Sem a flag: ask sem TTY nega a escrita e o run para.
  const denied = await run("ask", []);
  expect(denied.exit).toBe(1);
  expect(existsSync(join(denied.dir, "saida.txt"))).toBe(false);

  // Com a flag: bypass vence a config.
  const allowed = await run("ask", ["--permission-mode", "bypass"]);
  expect(allowed.exit).toBe(0);
  expect(existsSync(join(allowed.dir, "saida.txt"))).toBe(true);
});

test("--permission-mode inválido falha com erro de uso", async () => {
  const server = mockServer();
  try {
    const { dir, configPath } = project(server.port!, "ask");
    const result = await runCli(["run", "x", "--config", configPath, "--cwd", dir, "--permission-mode", "yolo"], {});
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("--permission-mode");
  } finally {
    server.stop(true);
  }
});

test("bypass audita mode.changed e cada decisão sem argumentos (#268)", async () => {
  const result = await run("bypass", []);
  expect(result.exit).toBe(0);

  const linhas = readFileSync(join(result.dir, ".astro", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tipo: string; payload: Record<string, unknown> });
  const mudanca = linhas.find((e) => e.tipo === "mode.changed");
  expect(mudanca?.payload).toMatchObject({ mode: "bypass" });

  const decisoes = linhas.filter((e) => e.tipo === "permission.decision");
  expect(decisoes.length).toBeGreaterThan(0);
  for (const decisao of decisoes) {
    expect(decisao.payload).toMatchObject({ mode: "bypass" });
    expect(decisao.payload).not.toHaveProperty("arguments");
    expect(decisao.payload).not.toHaveProperty("content");
  }
  expect(JSON.stringify(decisoes)).not.toContain("saida.txt");
});
