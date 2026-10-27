import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { validateConfig } from "../src/config";

/** Config mínima válida; `mcpServers` é o que cada teste varia. */
function configWith(mcpServers: unknown) {
  return validateConfig({
    providers: { a: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "K" } },
    models: [{ provider: "a", id: "m", tags: ["writing-code"], context: 8 }],
    agent: { model: "a/m", maxSteps: 1, tools: [] },
    mcpServers,
    paths: { ledger: "l", audit: "a" },
  });
}

test("config rejeita nome de servidor MCP com separador do namespace", () => {
  expect(() => configWith({ "a__b": { transport: "stdio", command: "x" } })).toThrow(/"mcpServers.a__b"/);
  expect(() => configWith({ "a/b": { transport: "stdio", command: "x" } })).toThrow(/"mcpServers.a\/b"/);
  expect(configWith({ "filesystem-1": { transport: "stdio", command: "x" } }).mcpServers!["filesystem-1"]).toBeDefined();
  expect(configWith({ a_b: { transport: "stdio", command: "x" } }).mcpServers!.a_b).toBeDefined();
});

const MOCK_SRC = `
import { writeFileSync } from "node:fs";
if (process.env.PID_FILE !== undefined) writeFileSync(process.env.PID_FILE, String(process.pid));
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
    if (msg.method === "initialize") reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } } });
    else if (msg.method === "tools/list") reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Ecoa", inputSchema: { type: "object" } }] } });
    else if (msg.method === "tools/call") reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "eco:" + msg.params.arguments.text }] } });
  }
});
`;

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { return true; }
  }
  return false;
}

/** Provider OpenAI-compat falso: grava as tools recebidas e responde um tool_call. */
function mockProvider() {
  let calls = 0;
  const toolsSeen: string[][] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no auth", { status: 401 });
      const body = (await req.json()) as { tools?: { function: { name: string } }[] };
      toolsSeen.push((body.tools ?? []).map((tool) => tool.function.name));
      calls++;
      return Response.json(calls === 1
        ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__mock__echo", arguments: JSON.stringify({ text: "ARG-SENTINEL-7731" }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
        : { choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 6, completion_tokens: 1 } });
    },
  });
  return { server, toolsSeen };
}

function writeConfig(dir: string, extra: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${(extra.port as number)}/v1`, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096 }],
    agent: { model: "mock/mock-1", maxSteps: 4, tools: extra.tools ?? [] },
    ...(extra.mcpServers === undefined ? {} : { mcpServers: extra.mcpServers }),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return path;
}

test("runTask descobre a tool MCP, expõe pela allowlist e fecha o servidor", async () => {
  const { server, toolsSeen } = mockProvider();
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-mcp-app-"));
    const script = join(dir, "mock-server.js");
    writeFileSync(script, MOCK_SRC.trim());
    const pidFile = join(dir, "pid");
    const configPath = writeConfig(dir, {
      port: server.port,
      tools: ["mcp__mock__echo"],
      mcpServers: { mock: { transport: "stdio", command: "bun", args: [script], env: { PID_FILE: pidFile }, timeoutMs: 3000 } },
    });

    const report = await runTask({ configPath, task: "eco", cwd: dir, env: { TEST_KEY: "test-key" } });

    expect(report.final).toBe("pronto");
    expect(toolsSeen[0]).toContain("mcp__mock__echo"); // o modelo vê o nome namespaced
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).toContain('"tipo":"mcp.call"');
    expect(audit).toContain('"server":"mock"');
    expect(audit).toContain('"status":"ok"');
    expect(audit).not.toContain("test-key"); // I-03: nem a chave do provider nem eco do argumento
    expect(audit).not.toContain("ARG-SENTINEL-7731");
    expect(await waitUntilDead(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("servidor MCP indisponível não derruba a sessão; tool sai da allowlist com warn", async () => {
  const { server, toolsSeen } = mockProvider();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-mcp-broken-"));
    const configPath = writeConfig(dir, {
      port: server.port,
      tools: ["mcp__broken__echo"],
      mcpServers: { broken: { transport: "stdio", command: "astro-comando-inexistente-xyz", timeoutMs: 1000 } },
    });

    const report = await runTask({ configPath, task: "siga", cwd: dir, env: { TEST_KEY: "test-key" } });

    expect(report.final).toBe("pronto"); // falha isolada: o run completa (critério de aceite)
    expect(toolsSeen[0]).not.toContain("mcp__broken__echo");
    expect(warn.mock.calls.flat().join(" ")).toContain("mcp__broken__echo");
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).not.toContain("mcp.call");
    expect(audit).not.toContain("test-key");
  } finally {
    warn.mockRestore();
    server.stop(true);
  }
});

test("ledger ilegível falha antes de spawnar servidor MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcp-ledger-"));
  const script = join(dir, "mock-server.js");
  writeFileSync(script, MOCK_SRC.trim());
  const pidFile = join(dir, "pid");
  mkdirSync(join(dir, ".astro"), { recursive: true });
  writeFileSync(join(dir, ".astro", "ledger.jsonl"), "{quebrado\n");
  const configPath = writeConfig(dir, {
    port: 1,
    tools: [],
    mcpServers: { mock: { transport: "stdio", command: "bun", args: [script], env: { PID_FILE: pidFile }, timeoutMs: 3000 } },
  });

  const error = (await runTask({ configPath, task: "x", cwd: dir, env: { TEST_KEY: "test-key" } }).catch((e) => e)) as Error;
  expect(error).toBeInstanceOf(Error);
  expect(existsSync(pidFile)).toBe(false); // baseline antes do connect: nada spawnou
});
