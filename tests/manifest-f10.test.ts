import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { CallJournal, callId } from "../src/call-id";
import { ToolExecutor } from "../src/tools/executor";
import { validateManifest } from "../src/sdk/tool";
import { editTool } from "../src/tools/edit";
import { grepTool } from "../src/tools/grep";
import { handoffTool } from "../src/tools/handoff";
import { listDirTool } from "../src/tools/list-dir";
import { lspTool } from "../src/tools/lsp";
import { pipelineTool } from "../src/tools/pipeline";
import { readFileTool } from "../src/tools/read-file";
import { runCommandTool } from "../src/tools/run-command";
import { writeFileTool } from "../src/tools/write-file";
import type { Tool, ToolManifest, ToolResult } from "../src/tools/types";

const full: ToolManifest = {
  name: "x", description: "d", parameters: { type: "object" },
  risk: "low", permission: "read", timeoutMs: 1000, retryable: true,
  idempotent: true, sideEffects: "none", class: "read_common",
};

const failMessage = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("validateManifest com idempotent e sideEffects (F-10)", () => {
  test("aceita manifesto completo e devolve os campos novos", () => {
    expect(validateManifest(full)).toEqual(full);
  });

  test("ausência de idempotent rejeita citando o campo", () => {
    const { idempotent: _drop, ...sem } = full;
    expect(failMessage(() => validateManifest(sem))).toContain("idempotent");
  });

  test("idempotent não-booleano rejeita", () => {
    expect(failMessage(() => validateManifest({ ...full, idempotent: "sim" }))).toContain("idempotent");
  });

  test("ausência de sideEffects rejeita citando o campo", () => {
    const { sideEffects: _drop, ...sem } = full;
    expect(failMessage(() => validateManifest(sem))).toContain("sideEffects");
  });

  test("sideEffects fora do vocabulário rejeita citando os quatro valores", () => {
    const msg = failMessage(() => validateManifest({ ...full, sideEffects: "database" }));
    expect(msg).toContain("sideEffects");
    expect(msg).toContain("network");
    expect(msg).toContain("process");
  });
});

describe("declarações das 9 tools builtin (F-10, I-12)", () => {
  const tools: Tool[] = [
    readFileTool, writeFileTool, editTool, grepTool, listDirTool,
    lspTool, runCommandTool, pipelineTool, handoffTool,
  ];

  test("todas declaram idempotent booleano e sideEffects do vocabulário", () => {
    for (const tool of tools) {
      expect(typeof tool.manifest.idempotent).toBe("boolean");
      expect(["none", "filesystem", "network", "process"]).toContain(tool.manifest.sideEffects);
    }
  });

  test("valores honestos: leituras none; write/edit filesystem; run_command e pipeline process; handoff none", () => {
    expect(readFileTool.manifest.idempotent).toBe(true);
    expect(readFileTool.manifest.sideEffects).toBe("none");
    expect(grepTool.manifest.sideEffects).toBe("none");
    expect(listDirTool.manifest.sideEffects).toBe("none");
    expect(lspTool.manifest.idempotent).toBe(true);
    expect(lspTool.manifest.sideEffects).toBe("none");
    expect(writeFileTool.manifest.idempotent).toBe(true);
    expect(writeFileTool.manifest.sideEffects).toBe("filesystem");
    expect(editTool.manifest.idempotent).toBe(false);
    expect(editTool.manifest.sideEffects).toBe("filesystem");
    expect(runCommandTool.manifest.idempotent).toBe(false);
    expect(runCommandTool.manifest.sideEffects).toBe("process");
    expect(pipelineTool.manifest.idempotent).toBe(false);
    expect(pipelineTool.manifest.sideEffects).toBe("process");
    expect(handoffTool.manifest.idempotent).toBe(true);
    expect(handoffTool.manifest.sideEffects).toBe("none");
  });
});

describe("gate do executor: dedup só para idempotentes (F-10)", () => {
  test("tool não idempotente executa sempre, sem tool.dedup; journal registra mesmo assim", async () => {
    let runs = 0;
    const tool: Tool = {
      manifest: {
        name: "deploy", description: "não idempotente",
        parameters: { type: "object", properties: {} },
        risk: "high", permission: "test", timeoutMs: 5000, retryable: false,
        idempotent: false, sideEffects: "process", class: "shell",
      },
      async execute(): Promise<ToolResult> {
        runs++;
        return { output: `exec ${runs}` };
      },
    };
    const audit = new Auditor(join(mkdtempSync(join(tmpdir(), "astro-f10-")), "audit.jsonl"));
    const executor = new ToolExecutor({ tools: [tool], allow: ["deploy"], audit });
    const journal = new CallJournal();
    const call = { id: "c1", name: "deploy", arguments: "{}" };
    const ctx = { cwd: ".", run: "r1", agent: "default", step: 1, journal };
    const r1 = await executor.run(ctx, call);
    const r2 = await executor.run(ctx, call);
    expect(runs).toBe(2);
    expect(r1.output).toBe("exec 1");
    expect(r2.output).toBe("exec 2");
    expect(audit.readAll().filter((e) => e.tipo === "tool.dedup")).toHaveLength(0);
    expect(journal.lookup(callId("r1", 1, call))).toBeDefined();
  });
});
