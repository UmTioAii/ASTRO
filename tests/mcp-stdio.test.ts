import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { MCPClient } from "../src/mcp/client";
import type { MCPServerConfig } from "../src/config";

const SERVER_SRC = `
const lines = [];
let buffer = "";
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" } } });
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Repete o texto", inputSchema: { type: "object" } },
        { name: "status", description: "Status do servidor" },
      ] } });
    } else if (msg.method === "tools/call") {
      if (process.env.MOCK_SILENT === "1") continue;
      const marker = process.env.MOCK_MARKER ?? "sem";
      const secret = process.env.ASTRO_TEST_API_KEY === undefined ? "sem" : "VAZOU";
      reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok:" + msg.params.name + ":" + msg.params.arguments.text + ":" + marker + ":" + secret }] } });
    }
  }
});
`;

function mockServerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-"));
  const path = join(dir, "mock-server.js");
  writeFileSync(path, SERVER_SRC.trim());
  return path;
}

const stdioServer = (script: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  transport: "stdio", command: "bun", args: [script], timeoutMs: 2000, enabled: true, ...extra,
});

test("config valida mcpServers com defaults e rejeita por transport", () => {
  const valid = validateConfig({
    providers: { a: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "K" } },
    models: [{ provider: "a", id: "m", tags: ["writing-code"], context: 8 }],
    agent: { model: "a/m", maxSteps: 1, tools: [] },
    mcpServers: { fs: { transport: "stdio", command: "bun" }, api: { transport: "http", url: "http://mcp/v1" } },
    paths: { ledger: "l", audit: "a" },
  });
  expect(valid.mcpServers!.fs).toMatchObject({ transport: "stdio", command: "bun", args: [], timeoutMs: 30000, enabled: true });
  expect(valid.mcpServers!.api).toMatchObject({ transport: "http", url: "http://mcp/v1" });

  const invalid = (servers: unknown) => () =>
    validateConfig({
      providers: { a: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "K" } },
      models: [{ provider: "a", id: "m", tags: ["writing-code"], context: 8 }],
      agent: { model: "a/m", maxSteps: 1, tools: [] },
      mcpServers: servers,
      paths: { ledger: "l", audit: "a" },
    });
  expect(invalid({ x: { transport: "stdio" } })).toThrow(/command/);
  expect(invalid({ x: { transport: "http" } })).toThrow(/url/);
  expect(invalid({ x: { transport: "grpc", command: "x" } })).toThrow(/transport/);
  expect(invalid({ x: { transport: "stdio", command: "x", timeoutMs: -1 } })).toThrow(/timeoutMs/);
  expect(invalid({ x: { transport: "stdio", command: "x", enabled: "sim" } })).toThrow(/enabled/);
});

test("client stdio conecta, lista e chama tools com env sanitizado", async () => {
  const script = mockServerPath();
  const client = await MCPClient.connect(stdioServer(script, { env: { MOCK_MARKER: "presente" } }));
  try {
    expect(client.serverInfo.name).toBe("mock");
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "status"]);

    const result = await client.callTool("echo", { text: "oi" });
    expect(result.content[0]!.text).toBe("ok:echo:oi:presente:sem"); // sem = chave do host não vaza (I-03)
  } finally {
    client.close();
  }
});

test("client stdio aplica timeout por requisição e fecha limpo", async () => {
  const script = mockServerPath();
  const silent = await MCPClient.connect(stdioServer(script, { env: { MOCK_SILENT: "1" }, timeoutMs: 500 }));
  await expect(silent.callTool("echo", { text: "x" })).rejects.toThrow(/timeout/);

  const client = await MCPClient.connect(stdioServer(script));
  client.close();
  await expect(client.listTools()).rejects.toThrow(/fechado/);

  const httpish = stdioServer(script, { transport: "http", url: "http://mcp" });
  await expect(MCPClient.connect(httpish)).rejects.toThrow(/não suportado/);
});
