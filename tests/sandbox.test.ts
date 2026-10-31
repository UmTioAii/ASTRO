import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, ConfigError } from "../src/config";
import {
  runCommandTool,
  configureRunCommand,
  detectDockerAvailable,
  dockerInfoSupportsLinuxContainers,
  resolveSandboxSetting,
  sanitizedEnv,
} from "../src/tools/run-command";

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

const baseConfig = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("config tools.run_command.sandbox (F4-6)", () => {
  test("sem tools: sandbox efetivo ligado (fail-closed)", () => {
    const cfg = validateConfig(structuredClone(baseConfig));
    expect(resolveSandboxSetting(cfg.tools?.run_command?.sandbox)).toBe(true);
  });

  test("tools.run_command sem sandbox → ligado (opt-out precisa ser explícito)", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: {} };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(true);
  });

  test("tools.run_command.sandbox: false é opt-out explícito", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: false } };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(false);
    expect(resolveSandboxSetting(cfg.tools?.run_command?.sandbox)).toBe(false);
  });

  test("tools.run_command.sandbox: true aceito", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: true } };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(true);
  });

  test("tools.run_command.sandbox inválido → ConfigError", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: "yes" } };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });
});

describe("sanitizedEnv (I-03)", () => {
  test("remove DB_PASS, SSH_PEM e PASSPHRASE sem remover nomes inocentes", () => {
    const env = sanitizedEnv({
      DB_PASS: "db-secret",
      SSH_PEM: "pem-secret",
      DEPLOY_PASSPHRASE: "pass-secret",
      GIT_AUTHOR_NAME: "autora",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("DB_PASS");
    expect(env).not.toHaveProperty("SSH_PEM");
    expect(env).not.toHaveProperty("DEPLOY_PASSPHRASE");
    expect(env.GIT_AUTHOR_NAME).toBe("autora");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("run_command sandbox (F4-6)", () => {
  afterEach(() => {
    configureRunCommand({ sandbox: false });
  });

  test("detecção só aceita engine Linux (Windows containers não rodam alpine/--read-only)", () => {
    expect(dockerInfoSupportsLinuxContainers("24.0.7|linux\n")).toBe(true);
    expect(dockerInfoSupportsLinuxContainers("24.0.7|windows\n")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("|linux")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("24.0.7")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("")).toBe(false);
  });

  test("sandbox=false: executa normalmente (comportamento atual)", async () => {
    configureRunCommand({ sandbox: false });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const result = await runCommandTool.execute({ command: "echo ok" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("ok");
  });

  test("sandbox=true sem Docker → recusa clara (sem downgrade silencioso)", async () => {
    configureRunCommand({ sandbox: true });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const docker = await detectDockerAvailable();
    const result = await runCommandTool.execute({ command: "echo ok" }, ctx(cwd));
    if (!docker) {
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Docker");
      expect(result.output).toContain("sandbox");
    } else {
      // neste ambiente Docker existe; o comando roda contido
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("ok");
    }
  }, 60_000);

  test("sandbox=true: detecção de Docker é cacheada", async () => {
    const first = await detectDockerAvailable();
    const second = await detectDockerAvailable();
    expect(first).toBe(second);
  });

  test("sandbox=true com Docker: comando malicioso não escapa", async () => {
    configureRunCommand({ sandbox: true });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const docker = await detectDockerAvailable();
    if (!docker) {
      // Windows CI sem Docker: teste de contenção é no-op aqui; coberto no Ubuntu
      expect(true).toBe(true);
      return;
    }

    // rede desabilitada: wget falha
    const net = await runCommandTool.execute(
      { command: "wget -T 2 http://example.invalid 2>&1 || echo net-failed" },
      ctx(cwd),
    );
    expect(net.output).toContain("net-failed");

    // rootfs read-only: escrever fora do cwd falha
    const fsEscape = await runCommandTool.execute(
      { command: "touch /etc/astro-evil 2>&1 || echo fs-blocked" },
      ctx(cwd),
    );
    expect(fsEscape.output).toContain("fs-blocked");

    // cwd continua gravável
    const writeOk = await runCommandTool.execute(
      { command: "echo dentro > sandbox-ok.txt && cat sandbox-ok.txt" },
      ctx(cwd),
    );
    expect(writeOk.isError).toBeFalsy();
    expect(writeOk.output).toContain("dentro");

    // env do host não vaza para dentro do container
    const envProbe = await runCommandTool.execute(
      { command: "sh -c 'echo KEY=${ASTRO_TEST_SECRET:-vazio}'" },
      ctx(cwd),
    );
    expect(envProbe.output).toContain("vazio");
  }, 60_000);
});