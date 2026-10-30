import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { validateConfig } from "../src/config";
import { MCPClient } from "../src/mcp/client";
import { resolveMcpHeaders } from "../src/mcp/headers";
import { MCPRegistry } from "../src/mcp/registry";

function configWithMcpHeaders(headers: Record<string, string>) {
  return validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 1, tools: [] },
    mcpServers: { api: { transport: "http", url: "http://127.0.0.1:1/mcp", headers } },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

test("config aceita header de autenticação por referência env", () => {
  const config = configWithMcpHeaders({ Authorization: "env:MCP_TOKEN", "X-Trace": "on" });
  expect(config.mcpServers!.api.headers).toEqual({ Authorization: "env:MCP_TOKEN", "X-Trace": "on" });
});

test("config aceita header de metadado terminado em -key", () => {
  const config = configWithMcpHeaders({ "Idempotency-Key": "run-1" });
  expect(config.mcpServers!.api.headers).toEqual({ "Idempotency-Key": "run-1" });
});

test("config rejeita header de autenticação com valor literal", () => {
  expect(() => configWithMcpHeaders({ Authorization: "Bearer sk-live-do-not-store" }))
    .toThrow(/env:NOME_DA_VARIAVEL/);
});

test("config rejeita valor com cara de credencial em header neutro", () => {
  expect(() => configWithMcpHeaders({ "X-Custom": "sk-live-do-not-store" }))
    .toThrow(/credencial/);
});

test("config rejeita env: com nome de variável inválido", () => {
  expect(() => configWithMcpHeaders({ Authorization: "env:lower-case" }))
    .toThrow(/env:NOME_DA_VARIAVEL/);
});

test("resolveMcpHeaders troca a referência pelo valor do ambiente", () => {
  expect(resolveMcpHeaders({ Authorization: "env:MCP_TOKEN", "X-Trace": "on" }, { MCP_TOKEN: "Bearer tok-123" }))
    .toEqual({ Authorization: "Bearer tok-123", "X-Trace": "on" });
});

test("resolveMcpHeaders cita só o nome da variável quando ela falta", () => {
  expect(() => resolveMcpHeaders({ Authorization: "env:MCP_TOKEN" }, {}))
    .toThrow(/MCP_TOKEN/);
});

function mcpHttpServer() {
  let authorization: string | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; id: number };
      if (body.method === "initialize") {
        authorization = req.headers.get("authorization");
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } },
          { headers: { "mcp-session-id": "sess-1" } },
        );
      }
      if (req.headers.get("mcp-session-id") !== "sess-1") return new Response(null, { status: 404 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    },
  });
  return { server, authorization: () => authorization };
}

test("config rejeita header com nome inválido", () => {
  expect(() => configWithMcpHeaders({ "Authorization ": "env:MCP_TOKEN" }))
    .toThrow(/não é um nome de header válido/);
});

test("config rejeita JWT e Basic em header neutro", () => {
  expect(() => configWithMcpHeaders({ "X-Custom": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" }))
    .toThrow(/credencial/);
  expect(() => configWithMcpHeaders({ "X-Custom": "Basic dXNlcjpwYXNz" }))
    .toThrow(/credencial/);
});

test("config aceita prosa com Basic/Bearer em header neutro", () => {
  expect(configWithMcpHeaders({ "X-Note": "Basic authentication required" }).mcpServers!.api.headers)
    .toEqual({ "X-Note": "Basic authentication required" });
  expect(configWithMcpHeaders({ "X-Note": "Bearer tokens are used" }).mcpServers!.api.headers)
    .toEqual({ "X-Note": "Bearer tokens are used" });
  expect(() => configWithMcpHeaders({ "X-Note": "Bearer tok-12345" })).toThrow(/credencial/);
});

test("resolveMcpHeaders rejeita caractere de controle sem ecoar o valor", () => {
  try {
    resolveMcpHeaders({ Authorization: "env:MCP_TOKEN" }, { MCP_TOKEN: "Bearer tok-123\nsecond-line" });
    throw new Error("deveria rejeitar");
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain("caractere de controle");
    expect(message).not.toContain("tok-123");
    expect(message).not.toContain("second-line");
  }
});

test("resolveMcpHeaders rejeita caractere fora de ASCII sem ecoar o valor", () => {
  try {
    resolveMcpHeaders({ Authorization: "env:MCP_TOKEN" }, { MCP_TOKEN: "Bearer tok-123\u2028second" });
    throw new Error("deveria rejeitar");
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain("ASCII");
    expect(message).not.toContain("tok-123");
    expect(message).not.toContain("second");
  }
});

test("client envia o header resolvido e nunca o nome da variável", async () => {
  const { server, authorization } = mcpHttpServer();
  try {
    const client = await MCPClient.connect({
      transport: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
      headers: { Authorization: "env:MCP_TOKEN" },
      timeoutMs: 2000,
      enabled: true,
    }, { MCP_TOKEN: "Bearer tok-123" });
    client.close();
    expect(authorization()).toBe("Bearer tok-123");
  } finally {
    server.stop(true);
  }
});

test("resolveMcpHeaders rejeita credencial literal mesmo fora da config", () => {
  expect(() => resolveMcpHeaders({ Authorization: "Bearer sk-live" }, {}))
    .toThrow(/env:NOME_DA_VARIAVEL/);
});

test("client falha antes de chamar a rede quando a variável do header falta", async () => {
  await expect(MCPClient.connect({
    transport: "http",
    url: "http://127.0.0.1:1/mcp",
    headers: { Authorization: "env:MCP_TOKEN" },
    timeoutMs: 300,
    enabled: true,
  }, { OTHER: "tok-999" })).rejects.toThrow(/MCP_TOKEN/);
});

test("runTask envia o header resolvido e não grava o valor no audit", async () => {
  let providerCalls = 0;
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no auth", { status: 401 });
      await req.json();
      providerCalls++;
      return Response.json(providerCalls === 1
        ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__api__echo", arguments: "{\"text\":\"oi\"}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
        : { choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 6, completion_tokens: 1 } });
    },
  });

  const mcp = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer tok-123") return new Response("no auth", { status: 401 });
      const body = (await req.json()) as { method: string; id: number };
      if (body.method === "initialize") {
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } },
          { headers: { "mcp-session-id": "sess-1" } },
        );
      }
      if (req.headers.get("mcp-session-id") !== "sess-1") return new Response(null, { status: 404 });
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "eco" }] } });
    },
  });

  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-mcp-header-"));
    const configPath = join(dir, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${provider.port}/v1`, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096 }],
      agent: { model: "mock/mock-1", maxSteps: 4, tools: ["mcp__api__echo"] },
      mcpServers: { api: { transport: "http", url: `http://127.0.0.1:${mcp.port}/mcp`, headers: { Authorization: "env:MCP_TOKEN" }, timeoutMs: 3000 } },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));

    const report = await runTask({ configPath, task: "eco", cwd: dir, env: { TEST_KEY: "test-key", MCP_TOKEN: "Bearer tok-123" } });

    expect(report.final).toBe("pronto");
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).toContain('"tipo":"mcp.call"');
    expect(audit).not.toContain("tok-123");
  } finally {
    provider.stop(true);
    mcp.stop(true);
  }
});

test("runTask não entrega ao run_command a variável referenciada por header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-header-shell-"));
  const probePath = join(dir, "probe.js");
  writeFileSync(probePath, "console.log(process.env.MCP_HEADER ?? 'VAZIO');");
  let calls = 0;
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no auth", { status: 401 });
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      bodies.push(body);
      calls++;
      return Response.json(calls === 1
        ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: `${process.execPath} ${probePath}` }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
        : { choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 6, completion_tokens: 1 } });
    },
  });
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${provider.port}/v1`, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096 }],
    agent: { model: "mock/mock-1", maxSteps: 4, tools: ["run_command"] },
    mcpServers: { api: { transport: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "env:MCP_HEADER" }, timeoutMs: 300 } },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));

  try {
    const report = await runTask({ configPath, task: "env", cwd: dir, env: { TEST_KEY: "test-key", MCP_HEADER: "tok-123" } });
    expect(report.final).toBe("pronto");
    const last = bodies.at(-1)?.messages.at(-1);
    expect(last?.role).toBe("tool");
    expect(last?.content).toContain("VAZIO");
    expect(last?.content).not.toContain("tok-123");
  } finally {
    provider.stop(true);
  }
});

const STDIO_ENV_SRC = `
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } });
    else if (msg.method === "tools/list") reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
    else if (msg.method === "tools/call") reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: process.env.MCP_HEADER ?? "sem" }] } });
  }
});
`;

test("stdio MCP não herda a variável referenciada por header", async () => {
  process.env.MCP_HEADER = "tok-123";
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-header-stdio-"));
  const script = join(dir, "server.js");
  writeFileSync(script, STDIO_ENV_SRC.trim());
  try {
    const client = await MCPClient.connect({
      transport: "stdio",
      command: "bun",
      args: [script],
      headers: { Authorization: "env:MCP_HEADER" },
      timeoutMs: 5000,
      enabled: true,
    });
    try {
      const result = await client.callTool("echo", {});
      expect(result.content[0]!.text).toBe("sem");
    } finally {
      client.close();
    }
  } finally {
    delete process.env.MCP_HEADER;
  }
});

test("stdio de um servidor não herda header env de outro servidor", async () => {
  process.env.MCP_HEADER = "tok-123";
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-header-registry-"));
  const script = join(dir, "server.js");
  writeFileSync(script, STDIO_ENV_SRC.trim());
  const registry = new MCPRegistry({
    servers: {
      api: { transport: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "env:MCP_HEADER" }, timeoutMs: 200, enabled: true },
      third: { transport: "stdio", command: "bun", args: [script], timeoutMs: 5000, enabled: true },
    },
    env: { MCP_HEADER: "tok-123" },
    warn: () => {},
  });
  try {
    const connected = await registry.connectAll();
    expect(connected.connected.some((entry) => entry.server === "third")).toBe(true);
    const result = await registry.call("third", "echo", {});
    expect(result.content[0]!.text).toBe("sem");
  } finally {
    registry.close();
    delete process.env.MCP_HEADER;
  }
});
