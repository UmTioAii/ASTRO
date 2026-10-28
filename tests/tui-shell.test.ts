import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellRunner } from "../src/tui/shell";

function config(tools: string[], credentialRef = "KEY", sandbox = false) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-shell-"));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "p/m1", maxSteps: 2, tools },
    tools: { run_command: { sandbox } },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath };
}

const slowCommand = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 5";

describe("!cmd da TUI (T2, #63)", () => {
  test("executa via run_command quando está na allowlist e audita", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(true);
    const result = await shell.run("echo astro-shell");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("astro-shell");
    expect(existsSync(join(cwd, ".astro", "audit.jsonl"))).toBe(true);
  });

  test("sem allowlist fica desabilitado e não executa nada", async () => {
    const { cwd, configPath } = config(["read_file"]);
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(false);
    const result = await shell.run("echo x > denied.txt");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("allowlist");
    expect(existsSync(join(cwd, "denied.txt"))).toBe(false);
  });

  test("comando vazio e falha do shell viram erro sem quebrar", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    expect(await shell.run("   ")).toMatchObject({ isError: true });
    const failed = await shell.run("comando-que-nao-existe-astro");
    expect(failed.isError).toBe(true);
    expect(failed.output.length).toBeGreaterThan(0);
  });

  test("não expõe credentialRef que não casa com SECRET_ENV", async () => {
    const { cwd, configPath } = config(["run_command"], "MY_API");
    const shell = createShellRunner({ configPath, cwd, env: { ...process.env, MY_API: "hunter2-abc" } });
    const command = process.platform === "win32" ? "echo %MY_API%" : "printenv MY_API";
    const result = await shell.run(command);
    expect(result.output).not.toContain("hunter2-abc");
  });

  test("abortar o sinal encerra o comando em vez de esperar o timeout", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await shell.run(slowCommand, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cancelado");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

test("abortar mata o processo filho, não só o shell", async () => {
  const { cwd, configPath } = config(["run_command"]);
  const shell = createShellRunner({ configPath, cwd, env: process.env });
  writeFileSync(join(cwd, "slow.js"), 'require("fs").writeFileSync("child.pid", String(process.pid)); setTimeout(() => {}, 30000);', "utf8");
  const controller = new AbortController();
  const pending = shell.run("bun slow.js", controller.signal);
  let childPid: number | undefined;
  for (let i = 0; i < 60 && childPid === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      childPid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
    } catch {
      // ainda não escreveu
    }
  }
  expect(childPid).toBeDefined();
  controller.abort();
  const result = await pending;
  expect(result.output).toContain("cancelado");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(() => process.kill(childPid!, 0)).toThrow();
});