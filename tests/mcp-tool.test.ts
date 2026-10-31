import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { mcpToolName } from "../src/mcp/registry";
import { mcpTools } from "../src/mcp/tool";
import { MCPError, type MCPToolResult } from "../src/mcp/types";
import { ToolExecutor } from "../src/tools/executor";

test("namespace mcp__<server>__<tool> é o contrato da tool vista pelo modelo", () => {
  expect(mcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
  expect(mcpToolName("server-1", "tool_2")).toBe("mcp__server-1__tool_2");
});

/** Fonte MCP de mentira: duas tools e chamadas gravadas (sem transporte real). */
function fakeSource(call: (server: string, tool: string, args: Record<string, unknown>) => Promise<MCPToolResult> = async (server, tool, args) => ({
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

function mcpEvents(audit: Auditor) {
  return audit.readAll().filter((entry) => entry.tipo === "mcp.call");
}

function mcpEvent(audit: Auditor) {
  const events = mcpEvents(audit);
  expect(events).toHaveLength(1);
  return events[0]!;
}

function executorFor(source: ReturnType<typeof fakeSource>["source"], audit: Auditor, allow: string[]): ToolExecutor {
  return new ToolExecutor({ tools: mcpTools({ registry: source, servers: { fs: { transport: "stdio", command: "x", timeoutMs: 2000, enabled: true } }, audit, reserved: [] }), allow, audit });
}

test("mcpTools executa pela allowlist e audita mcp.call sem argumentos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-tool-"));
  const audit = auditor(dir);
  const { source, calls } = fakeSource();
  const executor = executorFor(source, audit, ["mcp__fs__read_file"]);

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: JSON.stringify({ path: "a.txt", apiKey: "sk-live-SENTINEL" }) },
  );

  expect(result.isError).toBeUndefined();
  expect(result.output).toBe("fs/read_file:a.txt");
  expect(calls).toEqual([{ server: "fs", tool: "read_file", args: { path: "a.txt", apiKey: "sk-live-SENTINEL" } }]);
  const event = mcpEvent(audit);
  expect(event.payload).toMatchObject({ server: "fs", tool: "read_file", status: "ok" });
  expect(typeof event.payload.durationMs).toBe("number");
  expect(Object.keys(event.payload).sort()).toEqual(["durationMs", "server", "status", "tool"]);
  expect(JSON.stringify(audit.readAll())).not.toContain("sk-live-SENTINEL"); // I-03: nem argumento nem sentinela
});

test("tool MCP fora da allowlist não executa nem aparece em defs (I-01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-deny-"));
  const audit = auditor(dir);
  const { source, calls } = fakeSource();
  const executor = executorFor(source, audit, []);

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

test("duas tools MCP com o mesmo nome não se sobrescrevem", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-dup-"));
  const warnings: string[] = [];
  const tools = mcpTools({
    registry: {
      listTools: () => [
        { server: "fs", tool: { name: "read_file" } },
        { server: "fs", tool: { name: "read_file" } },
      ],
      call: async () => ({ content: [] }),
    },
    servers: {},
    audit: auditor(dir),
    reserved: [],
    warn: (message) => warnings.push(message),
  });

  expect(tools).toHaveLength(1);
  expect(warnings).toHaveLength(1);
});

test("falha da tool MCP vira resultado de erro e mcp.call status error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-error-"));
  const audit = auditor(dir);
  const { source } = fakeSource(async () => { throw new MCPError("boom"); });
  const executor = executorFor(source, audit, ["mcp__fs__read_file"]);

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "{}" },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain("boom");
  expect(mcpEvent(audit).payload).toMatchObject({ server: "fs", tool: "read_file", status: "error" });
});

test("isError do servidor MCP marca o audit como error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-iserror-"));
  const audit = auditor(dir);
  const { source } = fakeSource(async () => ({ content: [{ type: "text", text: "negado" }], isError: true }));
  const executor = executorFor(source, audit, ["mcp__fs__read_file"]);

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "{}" },
  );
  expect(result.isError).toBe(true);
  expect(result.output).toBe("negado");
  expect(mcpEvent(audit).payload).toMatchObject({ status: "error" });
});

test("resposta sem texto vira JSON e part nula não derruba a chamada", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-parts-"));
  const audit = auditor(dir);
  const { source } = fakeSource(async () => ({ content: [null, { type: "image", data: "x" }] } as unknown as MCPToolResult));
  const executor = executorFor(source, audit, ["mcp__fs__read_file"]);

  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "{}" },
  );
  expect(result.output).toBe('[{"type":"image","data":"x"}]');
  expect(mcpEvents(audit)).toHaveLength(1); // um único evento, sem "ok" seguido de "error"
});

test("argumentos não-objeto não chegam ao servidor MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-args-"));
  const audit = auditor(dir);
  const { source, calls } = fakeSource();
  const executor = executorFor(source, audit, ["mcp__fs__read_file"]);

  for (const args of ["[]", "null", "42", '"texto"']) {
    const result = await executor.run(
      { cwd: dir, run: "r1", agent: "a" },
      { id: `c-${args}`, name: "mcp__fs__read_file", arguments: args },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("objeto");
  }
  expect(calls).toEqual([]);
});

test("manifesto da tool MCP declara risco, permissão, timeout de retry e side effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-manifest-"));
  const { source } = fakeSource();
  const [tool] = mcpTools({
    registry: source,
    servers: { fs: { transport: "stdio", command: "x", timeoutMs: 2000, enabled: true } },
    audit: auditor(dir),
    reserved: [],
  });

  expect(tool!.manifest).toMatchObject({
    name: "mcp__fs__read_file",
    risk: "high",
    permission: "mcp:fs",
    timeoutMs: 9000, // 4 requisições do pior caso + 1s
    retryable: false,
    idempotent: false,
    sideEffects: "process",
    class: "shell",
  });
});

test("timeout do executor cobre o retry do registry (4x o timeout do servidor)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-timeout-"));
  const audit = auditor(dir);
  const { source } = fakeSource(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return { content: [{ type: "text", text: "ok" }] };
  });
  const tools = mcpTools({
    registry: source,
    servers: { fs: { transport: "stdio", command: "x", timeoutMs: 300, enabled: true } },
    audit,
    reserved: [],
  });
  const executor = new ToolExecutor({ tools, allow: ["mcp__fs__read_file"], audit });

  // 1400ms > timeout antigo (300+1000) e < 4*300+1000: o executor não pode preemptar o retry.
  const result = await executor.run(
    { cwd: dir, run: "r1", agent: "a" },
    { id: "c1", name: "mcp__fs__read_file", arguments: "{}" },
  );
  expect(result.isError).toBeUndefined();
  expect(result.output).toBe("ok");
});

test("inputSchema inválido cai no schema vazio e description vazia usa o default", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-schema-"));
  const [tool] = mcpTools({
    registry: {
      listTools: () => [{ server: "fs", tool: { name: "x", description: "  ", inputSchema: "não-objeto" as unknown as Record<string, unknown> } }],
      call: async () => ({ content: [] }),
    },
    servers: {},
    audit: auditor(dir),
    reserved: [],
  });

  expect(tool!.manifest.parameters).toEqual({ type: "object", properties: {} });
  expect(tool!.manifest.description).toBe("tool MCP fs/x");
});
