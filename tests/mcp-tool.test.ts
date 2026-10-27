import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { mcpTools } from "../src/mcp/tool";
import { MCPError } from "../src/mcp/types";
import { ToolExecutor } from "../src/tools/executor";

/** Fonte MCP de mentira: duas tools e chamadas gravadas (sem transporte real). */
function fakeSource(call: (server: string, tool: string, args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> = async (server, tool, args) => ({
  content: [{ type: "text", text: `${server}/${tool}:${String(args.path ?? "")}` }],
})) {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    source: {
      listTools: () => [
        { server: "fs", tool: { name: "read_file", description: "Lê arquivo", inputSchema: { type: "object" } } },
        { server: "fs", tool: { name: "write_file" } },
      ],
      call: (server: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ server, tool, args });
        return call(server, tool, args);
      },
    },
  };
}

function auditor(dir: string): Auditor {
  return new Auditor(join(dir, ".astro", "audit.jsonl"));
}

function mcpEvent(audit: Auditor) {
  const event = audit.readAll().find((entry) => entry.tipo === "mcp.call");
  expect(event).toBeDefined();
  return event!;
}

test("mcpTools executa pela allowlist e audita mcp.call sem argumentos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-tool-"));
  const audit = auditor(dir);
  const { source, calls } = fakeSource();
  const tools = mcpTools({ registry: source, servers: { fs: { transport: "stdio", command: "x", timeoutMs: 2000, enabled: true } }, audit });
  const executor = new ToolExecutor({ tools, allow: ["mcp__fs__read_file"], audit });

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: JSON.stringify({ path: "a.txt" }) },
  );

  expect(result.isError).toBeUndefined();
  expect(result.output).toBe("fs/read_file:a.txt");
  expect(calls).toEqual([{ server: "fs", tool: "read_file", args: { path: "a.txt" } }]);
  const event = mcpEvent(audit);
  expect(event.payload).toMatchObject({ server: "fs", tool: "read_file", status: "ok" });
  expect(typeof event.payload.durationMs).toBe("number");
  expect(Object.keys(event.payload).sort()).toEqual(["durationMs", "server", "status", "tool"]);
  expect(JSON.stringify(event.payload)).not.toContain("a.txt");
});

test("tool MCP fora da allowlist não executa nem aparece em defs (I-01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-deny-"));
  const audit = auditor(dir);
  const { source, calls } = fakeSource();
  const executor = new ToolExecutor({
    tools: mcpTools({ registry: source, servers: {}, audit }),
    allow: [],
    audit,
  });

  expect(executor.defs()).toEqual([]);
  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "{}" },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("não permitida");
  expect(calls).toEqual([]);
});

test("nome MCP em colisão com tool existente é ignorado com warn", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-collision-"));
  const warnings: string[] = [];
  const { source } = fakeSource();
  const tools = mcpTools({
    registry: source,
    servers: {},
    audit: auditor(dir),
    reserved: ["mcp__fs__read_file"],
    warn: (message) => warnings.push(message),
  });

  expect(tools.map((tool) => tool.manifest.name)).toEqual(["mcp__fs__write_file"]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("mcp__fs__read_file");
});

test("falha da tool MCP vira resultado de erro e mcp.call status error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-error-"));
  const audit = auditor(dir);
  const { source } = fakeSource(async () => { throw new MCPError("boom"); });
  const executor = new ToolExecutor({
    tools: mcpTools({ registry: source, servers: {}, audit }),
    allow: ["mcp__fs__read_file"],
    audit,
  });

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "{}" },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("boom");
  expect(mcpEvent(audit).payload).toMatchObject({ server: "fs", tool: "read_file", status: "error" });
});

test("argumentos não-objeto não chegam ao servidor MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-args-"));
  const audit = auditor(dir);
  const { source, calls } = fakeSource();
  const executor = new ToolExecutor({
    tools: mcpTools({ registry: source, servers: {}, audit }),
    allow: ["mcp__fs__read_file"],
    audit,
  });

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "[]" },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("objeto");
  expect(calls).toEqual([]);
});
