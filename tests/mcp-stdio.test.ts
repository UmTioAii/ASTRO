import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Repete o texto", inputSchema: { type: "object" } }, { name: "status", description: "Status do servidor" }] } });
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

/**
 * Servidor que registra o próprio pid e nunca responde: para pinnar vazamento
 * de processo. O pid é gravado no startup, não no primeiro `data`: sob carga,
 * o timeout de handshake pode vencer antes de o filho ler o stdin, e o teste
 * falharia por ENOENT em vez de provar o vazamento.
 */
const SILENT_INIT_SRC = `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PID_FILE, String(process.pid));
process.stdin.resume();
`;

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { return true; }
  }
  return false;
}

/** Espera o arquivo aparecer; startup do bun sob carga não é instantâneo. */
async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(path);
}

// Handshake de processos reais precisa de folga sob carga; testes de timeout
// usam valores explícitos e curtos no próprio caso.
const stdioServer = (script: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  transport: "stdio", command: "bun", args: [script], timeoutMs: 5000, enabled: true, ...extra,
});

test("config valida mcpServers com defaults e rejeita por transport", () => {
  const withServers = (servers: unknown) => validateConfig({
    providers: { a: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "K" } },
    models: [{ provider: "a", id: "m", tags: ["writing-code"], context: 8 }],
    agent: { model: "a/m", maxSteps: 1, tools: [] },
    mcpServers: servers,
    paths: { ledger: "l", audit: "a" },
  });
  const valid = withServers({
    fs: { transport: "stdio", command: "bun", retryBackoffMs: 250 },
    api: { transport: "http", url: "http://mcp/v1" },
  });
  expect(valid.mcpServers!.fs).toMatchObject({ transport: "stdio", command: "bun", args: [], timeoutMs: 30000, enabled: true, retryBackoffMs: 250 });
  expect(valid.mcpServers!.api).toMatchObject({ transport: "http", url: "http://mcp/v1" });
  expect(valid.mcpServers!.api.retryBackoffMs).toBeUndefined(); // default vive no registry

  const invalid = (servers: unknown) => () => withServers(servers);
  expect(invalid({ x: { transport: "stdio" } })).toThrow(/command/);
  expect(invalid({ x: { transport: "http" } })).toThrow(/url/);
  expect(invalid({ x: { transport: "grpc", command: "x" } })).toThrow(/transport/);
  expect(invalid({ x: { transport: "stdio", command: "x", timeoutMs: -1 } })).toThrow(/timeoutMs/);
  expect(invalid({ x: { transport: "stdio", command: "x", enabled: "sim" } })).toThrow(/enabled/);
  expect(invalid({ x: { transport: "stdio", command: "x", retryBackoffMs: 0 } })).toThrow(/retryBackoffMs/);
  expect(invalid({ x: { transport: "stdio", command: "x", retryBackoffMs: 1.5 } })).toThrow(/retryBackoffMs/);
  expect(invalid({ x: { transport: "stdio", command: "x", retryBackoffMs: "100" } })).toThrow(/retryBackoffMs/);
});

test("client stdio conecta, lista e chama tools com env sanitizado", async () => {
  process.env.ASTRO_TEST_API_KEY = "dummy"; // a sanitização precisa provar que essa NÃO chega ao servidor
  const script = mockServerPath();
  const client = await MCPClient.connect(stdioServer(script, { env: { MOCK_MARKER: "presente" } }));
  try {
    expect(client.serverInfo.name).toBe("mock");
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "status"]);

    const result = await client.callTool("echo", { text: "oi" });
    expect(result.content[0]!.text).toBe("ok:echo:oi:presente:sem"); // sem = chave do host não vaza (I-03)
  } finally {
    delete process.env.ASTRO_TEST_API_KEY;
    client.close();
  }
});

test("connect com handshake travado não vaza o processo filho", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-leak-"));
  const script = join(dir, "silent-init.js");
  writeFileSync(script, SILENT_INIT_SRC.trim());
  const pidFile = join(dir, "pid");
  const server = stdioServer(script, { timeoutMs: 3000, env: { PID_FILE: pidFile } });

  await expect(MCPClient.connect(server)).rejects.toThrow(/timeout/);
  expect(await waitForFile(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(await waitUntilDead(pid)).toBe(true); // rejeição sem handle não pode deixar órfão
}, 15_000);

test("client stdio aplica timeout por requisição e fecha limpo", async () => {
  const script = mockServerPath();
  const silent = await MCPClient.connect(stdioServer(script, { env: { MOCK_SILENT: "1" }, timeoutMs: 3000 }));
  await expect(silent.callTool("echo", { text: "x" })).rejects.toThrow(/timeout/);
  silent.close();

  const client = await MCPClient.connect(stdioServer(script));
  client.close();
  await expect(client.listTools()).rejects.toThrow(/fechado/);

  const httpish = stdioServer(script, { transport: "http", url: "http://mcp" });
  await expect(MCPClient.connect(httpish)).rejects.toThrow(/falha|timeout/);
}, 15_000);
