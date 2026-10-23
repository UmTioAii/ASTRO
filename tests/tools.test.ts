import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { resolveWithin } from "../src/tools/paths";
import { readFileTool } from "../src/tools/read-file";
import { runCommandTool } from "../src/tools/run-command";
import type { Tool, ToolResult } from "../src/tools/types";
import { writeFileTool } from "../src/tools/write-file";

const dir = () => mkdtempSync(join(tmpdir(), "astro-tools-"));
const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "default" });
const tools = [readFileTool, writeFileTool, runCommandTool];
const mkExec = (cwd: string) =>
  new ToolExecutor({ tools, allow: tools.map((t) => t.manifest.name), audit: new Auditor(join(cwd, ".astro", "audit.jsonl")) });

test("caminho fora do cwd é recusado; dentro é aceito", () => {
  const cwd = dir();
  expect(resolveWithin(cwd, "ok.txt")).toBe(join(cwd, "ok.txt"));
  expect(() => resolveWithin(cwd, "../escape.txt")).toThrow(/fora/);
  expect(() => resolveWithin(cwd, resolve(cwd, "..", "outside.txt"))).toThrow(/fora/);
});

test("write+read roundtrip no cwd", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  const w = await ex.run(ctx(cwd), { id: "1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "olá" }) });
  expect(w.isError).toBeFalsy();
  const r = await ex.run(ctx(cwd), { id: "2", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) });
  expect(r.output).toBe("olá");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("olá");
});

test("tool desconhecida, args ilegíveis e fora do allow → erro, não crash", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  expect((await ex.run(ctx(cwd), { id: "1", name: "ghost", arguments: "{}" })).isError).toBe(true);
  expect((await ex.run(ctx(cwd), { id: "2", name: "read_file", arguments: "{quebrado" })).isError).toBe(true);
  const denied = new ToolExecutor({ tools: [readFileTool], allow: [], audit: new Auditor(join(cwd, ".astro", "audit2.jsonl")) });
  expect((await denied.run(ctx(cwd), { id: "3", name: "read_file", arguments: '{"path":"a.txt"}' })).isError).toBe(true);
});

test("timeout devolve erro", async () => {
  const cwd = dir();
  const slow: Tool = {
    manifest: { name: "slow", description: "x", parameters: {}, risk: "low", permission: "read", timeoutMs: 30, retryable: false },
    execute: () => new Promise<ToolResult>(() => {}),
  };
  const ex = new ToolExecutor({ tools: [slow], allow: ["slow"], audit: new Auditor(join(cwd, ".astro", "audit.jsonl")) });
  const r = await ex.run(ctx(cwd), { id: "1", name: "slow", arguments: "{}" });
  expect(r.isError).toBe(true);
  expect(r.output.toLowerCase()).toContain("timeout");
});

test("run_command captura a saída", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  const r = await ex.run(ctx(cwd), { id: "1", name: "run_command", arguments: JSON.stringify({ command: "bun --version" }) });
  expect(r.isError).toBeFalsy();
  expect(r.output.length).toBeGreaterThan(0);
});

test("emite tool.call e tool.result na auditoria", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  await ex.run(ctx(cwd), { id: "1", name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "x" }) });
  const lines = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.tipo)).toEqual(["tool.call", "tool.result"]);
});
