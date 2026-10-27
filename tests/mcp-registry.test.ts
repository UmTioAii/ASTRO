import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPError } from "../src/mcp/types";
import type { MCPServerConfig } from "../src/config";
import { MCPRegistry } from "../src/mcp/registry";

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
      if (process.env.PID_FILE !== undefined) appendFileSync(process.env.PID_FILE, process.pid + "\\n");
      if (process.env.INIT_DELAY !== undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.INIT_DELAY));
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stdio-registry", version: "1" } } });
    } else if (msg.method === "tools/list") reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo" }, { name: "boom" }, { name: "suicide" }] } });
    else if (msg.params?.name === "boom") reply({ jsonrpc: "2.0", id: msg.id, error: { message: "boom ferramenta" } });
    else if (msg.params?.name === "suicide") process.exit(1);
    else reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "stdio-ok" }] } });
  }
});
`;

function writeStub(dir: string): string {
  const script = join(dir, "server.js");
  writeFileSync(script, STUB.trim());
  return script;
}
const pidFileOf = (dir: string) => join(dir, "pids");
const pids = (file: string): number[] =>
  (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []).map(Number);
const waitDead = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { return true; }
  }
  return false;
};
const stdioCfg = (pidFile: string, delay?: number): MCPServerConfig => ({
  transport: "stdio", command: "bun", args: [writeStub(join(pidFile, ".."))], timeoutMs: 3000, enabled: true,
  env: delay === undefined ? { PID_FILE: pidFile } : { PID_FILE: pidFile, INIT_DELAY: String(delay) },
});

test("registry conecta com isolamento, namespace e cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const script = writeStub(dir);
  const pidFile = pidFileOf(dir);
  const warnings: string[] = [];
  const registry = new MCPRegistry({
    servers: {
      fs: { transport: "stdio", command: "bun", args: [script], timeoutMs: 3000, enabled: true, env: { PID_FILE: pidFile } },
      morto: { transport: "stdio", command: "bun", args: [join(dir, "nao-existe.js")], timeoutMs: 3000, enabled: true },
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
  expect(pids(pidFile)).toHaveLength(1);

  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");
  await expect(registry.call("morto", "echo", {})).rejects.toThrow(/morto/);
  await expect(registry.call("off", "echo", {})).rejects.toThrow(/desabilitado/);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok"); // fs segue vivo

  registry.close();
});

test("erro de tool não reconecta nem reexecuta; morte do servidor reconecta uma vez", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile) }, warn: () => {} });

  await registry.connectAll();
  expect(pids(pidFile)).toHaveLength(1);

  // erro de tool (JSON-RPC error): propaga sem reconexão; assert via .then (expect.rejects afoga stdout no bun/win)
  const caught = await registry.call("fs", "boom", {}).then(() => "resolvido", (error: Error) => error.message);
  expect(caught).toMatch(/boom ferramenta/);
  expect(pids(pidFile)).toHaveLength(1);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");

  // morte do processo na chamada: reconecta uma vez e segue
  await expect(registry.call("fs", "suicide", {})).rejects.toThrow(/encerrou|indisponível/);
  expect(pids(pidFile)).toHaveLength(2);
  expect((await registry.call("fs", "echo", {})).content[0]!.text).toBe("stdio-ok");

  // registro fechado não ressuscita servidor
  registry.close();
  await expect(registry.call("fs", "echo", {})).rejects.toThrow(/fechado/);
});

test("chamadas concorrentes em cliente morto: MCPError e uma reconexão", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile) }, warn: () => {} });
  await registry.connectAll();
  process.kill(pids(pidFile)[0]!); // morte fora do registry
  await new Promise((resolve) => setTimeout(resolve, 200));

  const results = await Promise.allSettled([
    registry.call("fs", "echo", {}),
    registry.call("fs", "echo", {}),
    registry.call("fs", "echo", {}),
  ]);
  for (const result of results) {
    if (result.status === "fulfilled") expect(result.value.content[0]!.text).toBe("stdio-ok");
    else expect(result.reason instanceof MCPError).toBe(true); // nada de TypeError cru
  }
  expect(pids(pidFile)).toHaveLength(2); // exatamente uma reconexão
  registry.close();
});

test("close durante reconexão não deixa órfão e classifica o erro", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile, 400) }, warn: () => {} });
  await registry.connectAll();
  process.kill(pids(pidFile)[0]!);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const inFlight = registry.call("fs", "echo", {});
  await new Promise((resolve) => setTimeout(resolve, 100)); // reconexão (initialize lento) em voo
  registry.close();
  await expect(inFlight).rejects.toThrow(/fechado/);
  await expect(waitDead(pids(pidFile)[1]!)).resolves.toBe(true); // cliente pós-close é fechado
});

test("close durante connectAll não deixa órfãos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpreg-"));
  const pidFile = pidFileOf(dir);
  const registry = new MCPRegistry({ servers: { fs: stdioCfg(pidFile), lento: stdioCfg(join(dir, "pids-lento"), 400) }, warn: () => {} });
  const inFlight = registry.connectAll();
  await new Promise((resolve) => setTimeout(resolve, 150)); // fs conectou, lento em voo
  registry.close();
  await expect(inFlight).rejects.toThrow(/fechado/);
  await expect(waitDead(pids(join(dir, "pids-lento"))[0]!)).resolves.toBe(true);
});

test("http com sessão expirada reconecta e recupera", async () => {
  let sessions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; id: number };
      if (body.method === "initialize") {
        sessions += 1;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sess-mock", version: "1" } } }, { headers: { "mcp-session-id": `sess-${sessions}` } });
      }
      if (req.headers.get("mcp-session-id") !== `sess-${sessions}`) return new Response(null, { status: 404 }); // sessão expirada
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo" }] } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ok:${sessions}` }] } });
    },
  });
  try {
    const registry = new MCPRegistry({ servers: { api: { transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs: 2000, enabled: true } }, warn: () => {} });
    try {
      expect((await registry.connectAll()).connected).toHaveLength(1);
      expect((await registry.call("api", "echo", {})).content[0]!.text).toBe("ok:1");
      sessions += 1; // servidor expira sess-1
      expect((await registry.call("api", "echo", {})).content[0]!.text).toBe("ok:3"); // reconecta e recupera
      expect(sessions).toBe(3);
    } finally {
      registry.close();
    }
  } finally {
    server.stop(true);
  }
});

