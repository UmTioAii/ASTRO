import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { validateConfig } from "../src/config";
import { MCPClient } from "../src/mcp/client";
import { resolveMcpHeaders } from "../src/mcp/headers";

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
