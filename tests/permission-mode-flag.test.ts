import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("--permission-mode bypass sobrepõe permissions.mode ask (#269)", async () => {
  const server = mockServer();
  try {
    // Sem a flag: ask sem TTY nega a escrita e o run para.
    const semFlag = project(server.port, "ask");
    const denied = await runCli(["run", "escreva", "--config", semFlag.configPath, "--cwd", semFlag.dir], { TEST_KEY: "k" });
    expect(denied.exit).toBe(1);
    expect(existsSync(join(semFlag.dir, "saida.txt"))).toBe(false);

    // Com a flag: bypass vence a config.
    const comFlag = project(server.port, "ask");
    const allowed = await runCli(
      ["run", "escreva", "--config", comFlag.configPath, "--cwd", comFlag.dir, "--permission-mode", "bypass"],
      { TEST_KEY: "k" },
    );
    expect(allowed.exit).toBe(0);
    expect(existsSync(join(comFlag.dir, "saida.txt"))).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("--permission-mode inválido falha com erro de uso", async () => {
  const { dir, configPath } = project(1, "ask");
  const result = await runCli(["run", "x", "--config", configPath, "--cwd", dir, "--permission-mode", "yolo"], {});
  expect(result.exit).not.toBe(0);
  expect(result.stderr).toContain("--permission-mode");
});
