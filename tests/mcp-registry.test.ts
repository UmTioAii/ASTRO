import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPRegistry, mcpToolName } from "../src/mcp/registry";

const STUB = `
import { appendFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line);
    const reply = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (msg.method === "initialize") {
      if (process.env.STARTUP_FILE !== undefined) appendFileSync(process.env.STARTUP_FILE, "x");
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stdio-registry", version: "1" } } });
    } else if (msg.method === "tools/list") reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo" }, { name: "boom" }, { name: "suicide" }] } });
    else if (msg.params?.name === "boom") reply({ jsonrpc: "2.0", id: msg.id, error: { message: "boom ferramenta" } });
    else if (msg.params?.name === "suicide") process.exit(1);
    else reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "stdio-ok" }] } });
  }
});
`;

function stubServerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const path = join(dir, "server.js");
  writeFileSync(path, STUB.trim());
  return path;
}

test("registry conecta com isolamento, namespace e cache", async () => {
  const script = stubServerPath();
  const warnings: string[] = [];
  const registry = new MCPRegistry({
    servers: {
      fs: { transport: "stdio", command: "bun", args: [script], timeoutMs: 3000, enabled: true },
      morto: { transport: "stdio", command: "bun", args: [script.replace("server.js", "nao-existe.js")], timeoutMs: 3000, enabled: true },
      off: { transport: "stdio", command: "bun", args: [script], timeoutMs: 3000, enabled: false },
    },
    warn: (message) => warnings.push(message),
  });

  const report = await registry.connectAll();
  expect(report.connected.map((info) => info.server)).toEqual(["fs"]);
  expect(report.failed.map((info) => info.server)).toEqual(["morto"]);
  expect(warnings.join("\n")).toMatch(/morto/);

  expect(registry.listTools()).toEqual([
    { server: "fs", tool: { name: "echo" } }, { server: "fs", tool: { name: "boom" } }, { server: "fs", tool: { name: "suicide" } },
  ]);
  expect(mcpToolName("fs", "echo")).toBe("mcp__fs__echo");

  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");
  await expect(registry.call("morto", "echo", {})).rejects.toThrow(/morto/);
  await expect(registry.call("off", "echo", {})).rejects.toThrow(/desabilitado/);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok"); // fs segue vivo

  registry.close();
});

test("erro de tool não reconecta nem reexecuta; morte do servidor reconecta uma vez", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg2-"));
  const startupFile = join(dir, "startups");
  const script = join(dir, "server.js");
  writeFileSync(script, STUB.trim());
  const registry = new MCPRegistry({
    servers: { fs: { transport: "stdio", command: "bun", args: [script], timeoutMs: 3000, enabled: true, env: { STARTUP_FILE: startupFile } } },
    warn: () => {},
  });
  const startups = () => (existsSync(startupFile) ? readFileSync(startupFile, "utf8").length : 0);

  await registry.connectAll();
  expect(startups()).toBe(1);

  // erro de tool (JSON-RPC error): propaga sem reconexão; assert via .then (expect.rejects afoga stdout no bun/win)
  const caught = await registry.call("fs", "boom", {}).then(() => "resolvido", (error: Error) => error.message);
  expect(caught).toMatch(/boom ferramenta/);
  expect(startups()).toBe(1);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");

  // morte do processo na chamada: reconecta uma vez e segue
  await expect(registry.call("fs", "suicide", {})).rejects.toThrow(/encerrou|indisponível/);
  expect(startups()).toBe(2);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");

  // registro fechado não ressuscita servidor
  registry.close();
  await expect(registry.call("fs", "echo", {})).rejects.toThrow(/fechado/);
});

