import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ConfigError, validateConfig } from "../src/config";
import {
  actionClassOf,
  isCriticalReadPath,
  permissionDecision,
  resolvePermissionMode,
  type ActionClass,
  type PermissionDecision,
  type PermissionMode,
} from "../src/permissions";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { runCommandTool } from "../src/tools/run-command";
import { writeFileTool } from "../src/tools/write-file";
import type { Tool } from "../src/tools/types";

const expected: Record<PermissionMode, Record<ActionClass, PermissionDecision>> = {
  bypass: {
    read_common: "allow", read_critical: "allow", edit: "allow", delete: "allow", shell: "allow", identity: "ask",
  },
  "allow-edits": {
    read_common: "allow", read_critical: "ask", edit: "allow", delete: "ask", shell: "ask", identity: "ask",
  },
  ask: {
    read_common: "allow", read_critical: "ask", edit: "ask", delete: "ask", shell: "ask", identity: "ask",
  },
};

describe("matriz de permissão (#259)", () => {
  test("modo × classe de ação", () => {
    for (const [mode, row] of Object.entries(expected) as [PermissionMode, Record<ActionClass, PermissionDecision>][]) {
      for (const [action, decision] of Object.entries(row) as [ActionClass, PermissionDecision][]) {
        expect({ mode, action, decision: permissionDecision(mode, action) }).toEqual({ mode, action, decision });
      }
    }
  });

  test("troca de identidade nunca é automática, nem em bypass", () => {
    expect(permissionDecision("bypass", "identity")).toBe("ask");
    expect(permissionDecision("allow-edits", "identity")).toBe("ask");
  });

  test("resolução: explícito > config > padrão ask", () => {
    expect(resolvePermissionMode("bypass", "ask")).toBe("bypass");
    expect(resolvePermissionMode(undefined, "allow-edits")).toBe("allow-edits");
    expect(resolvePermissionMode(undefined, undefined)).toBe("ask");
  });

  test("classificação de leitura crítica por caminho", () => {
    expect(isCriticalReadPath(".env")).toBe(true);
    expect(isCriticalReadPath("config/keys/prod.json")).toBe(true);
    expect(isCriticalReadPath(".astro/ledger.jsonl")).toBe(true);
    expect(isCriticalReadPath("src/app.ts")).toBe(false);
  });

  test("classe da ação vem do manifesto da tool", () => {
    const call = (name: string, input: unknown) => ({ name, input });
    expect(actionClassOf(readFileTool, call("read_file", { path: "src/app.ts" }))).toBe("read_common");
    expect(actionClassOf(readFileTool, call("read_file", { path: ".env" }))).toBe("read_critical");
    expect(actionClassOf(writeFileTool, call("write_file", { path: "a.txt", content: "x" }))).toBe("edit");
    expect(actionClassOf(runCommandTool, call("run_command", { command: "echo oi" }))).toBe("shell");
  });

  test("config aceita permissions.mode e rejeita valor inválido", () => {
    const base = {
      providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    };

    expect(validateConfig(structuredClone(base)).permissions).toEqual({ mode: "ask" });
    expect(validateConfig({ ...structuredClone(base), permissions: { mode: "bypass" } }).permissions)
      .toEqual({ mode: "bypass" });
    expect(() => validateConfig({ ...structuredClone(base), permissions: { mode: "yolo" } })).toThrow(ConfigError);
  });
});

describe("gate no executor (#259)", () => {
  const manifest = {
    description: "teste", parameters: { type: "object", properties: {} },
    risk: "low" as const, permission: "test", timeoutMs: 5_000, retryable: false,
    idempotent: false, sideEffects: "none" as const,
  };

  function setup(tools: Tool[], opts: { mode?: PermissionMode; approve?: () => boolean } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "astro-perm-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools,
      allow: tools.map((t) => t.manifest.name),
      audit,
      ...(opts.mode === undefined ? {} : { permissionMode: opts.mode }),
      ...(opts.approve === undefined ? {} : { approveTool: opts.approve }),
    });
    return { cwd, audit, executor };
  }

  test("bypass libera shell", async () => {
    const { cwd, executor } = setup([runCommandTool], { mode: "bypass" });
    const result = await executor.run({ cwd, run: "r1", agent: "a", env: { ...process.env } },
      { id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo oi" }) });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("oi");
  });

  test("ask + approver negando bloqueia a tool e audita", async () => {
    let ran = false;
    const write: Tool = {
      manifest: { ...manifest, name: "write_probe", permission: "write", sideEffects: "filesystem" },
      async execute() {
        ran = true;
        return { output: "ok" };
      },
    };
    const { cwd, audit, executor } = setup([write], { mode: "ask", approve: () => false });
    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "write_probe", arguments: "{}" });

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("permiss");
    const decisoes = audit.readAll().filter((e) => e.tipo === "permission.decision");
    expect(decisoes).toHaveLength(1);
    expect(decisoes[0]!.payload).toMatchObject({ name: "write_probe", action: "edit", mode: "ask", decision: "deny" });
  });

  test("ask + approver permitindo executa", async () => {
    let ran = false;
    const write: Tool = {
      manifest: { ...manifest, name: "write_probe", permission: "write", sideEffects: "filesystem" },
      async execute() {
        ran = true;
        return { output: "ok" };
      },
    };
    const { cwd, executor } = setup([write], { mode: "ask", approve: () => true });
    const result = await executor.run({ cwd, run: "r1", agent: "a" },
      { id: "c1", name: "write_probe", arguments: "{}" });

    expect(ran).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  test("piso fixo: bypass não escreve em .astro", async () => {
    const { cwd, executor } = setup([writeFileTool], { mode: "bypass" });
    const result = await executor.run({ cwd, run: "r1", agent: "a" }, {
      id: "c1", name: "write_file",
      arguments: JSON.stringify({ path: ".astro/ledger.jsonl", content: "x" }),
    });

    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, ".astro", "ledger.jsonl"))).toBe(false);
  });
});
