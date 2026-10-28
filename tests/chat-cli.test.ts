import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Auditor } from "../src/audit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("bun src/cli.ts chat roda um turno e encerra com /exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-"));
  const server = Bun.serve({ port: 0, async fetch() {
    return Response.json({ choices: [{ message: { content: "ok do mock" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  } });
  try {
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192,
        price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } }],
      agent: { model: "p/m1", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", configPath, "--cwd", cwd], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, KEY: "k" } as Record<string, string>,
    });
    proc.stdin.write("olá\n/providers\n/help\n/exit\n");
    proc.stdin.end();
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(stdout).toContain("astro chat");
    expect(stdout).toContain("ok do mock");
    expect(stdout).toContain("Comandos:"); // a linha /help depois do turno não foi perdida
    expect(stdout).toContain("p (openai-compat)");
    expect(stdout).toContain("1 step(s)");
    expect(existsSync(join(cwd, ".astro", "sessions"))).toBe(true);
    expect(readdirSync(join(cwd, ".astro", "sessions")).some((name) => name.endsWith(".json"))).toBe(true);
    const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
    expect(audit.some((e) => e.tipo === "chat.prompt")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("olá");
  } finally {
    server.stop(true);
  }
}, 20_000);

test("erro de provider não encerra o REPL e aceita /exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-err-"));
  const server = Bun.serve({ port: 0, async fetch() { return new Response("boom", { status: 500 }); } });
  try {
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", configPath, "--cwd", cwd], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, KEY: "k" } as Record<string, string>,
    });
    proc.stdin.write("a\n/exit\n");
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("erro:");
  } finally {
    server.stop(true);
  }
}, 20_000);

test("chat sem --config inválido falha claro", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-cli-bad-"));
  const proc = Bun.spawn(["bun", "src/cli.ts", "chat", "--config", join(cwd, "nope.json"), "--cwd", cwd], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.end();
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("erro:");
}, 20_000);
