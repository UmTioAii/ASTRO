import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "../src/mcp/client";
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

test("registry conecta com isolamento, namespace e cache invalidável", async () => {
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

  registry.invalidate("fs");
  expect(registry.listTools()).toEqual([]);
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

/** Mock de servidor streamable HTTP com modos de defeito e controle de chunking. */
function httpMock(opts: { postStatus?: number; nullBody?: boolean; nullEvent?: boolean; splitUtf8?: boolean } = {}) {
  const posts: { method: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; id: number };
      posts.push({ method: body.method });
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "http-mock", version: "1" } } }, { headers: { "mcp-session-id": "s" } });
      }
      if (opts.postStatus !== undefined && body.method === "tools/list") return new Response(null, { status: opts.postStatus });
      if (opts.nullBody === true) return Response.json(null);
      const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ação:${body.id}` }] } });
      if (opts.nullEvent === true || opts.splitUtf8 === true) {
        const payload = `${opts.nullEvent === true ? "data: null\n\n" : ""}data: ${message}\n\n`;
        const bytes = new TextEncoder().encode(payload);
        // corta DENTRO da sequência UTF-8 do "ç" (0xC3 0xA7) para forçar recompôsição entre chunks
        const cut = opts.splitUtf8 === true ? bytes.findIndex((byte, i) => byte === 0xC3 && bytes[i + 1] === 0xA7) + 1 : bytes.length;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              setTimeout(() => { try { controller.enqueue(bytes.slice(cut)); } catch { /* stream já consumido */ } }, 20);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ok:${body.id}` }] } });
    },
  });
  return { server, posts };
}

const http = (server: { port?: number }, timeoutMs: number) =>
  MCPClient.connect({ transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs, enabled: true });

test("transport http: POST não-2xx, corpo null e evento null não derrubam a requisição", async () => {
  const failing = httpMock({ postStatus: 500 });
  try {
    const client = await http(failing.server, 2000);
    try {
      await expect(client.listTools()).rejects.toThrow(/HTTP 500 no MCP tools\/list/);
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("ok:3"); // transport segue usável
    } finally { client.close(); }
  } finally { failing.server.stop(true); }

  const nullBody = httpMock({ nullBody: true });
  try {
    const client = await http(nullBody.server, 2000);
    try { await expect(client.listTools()).rejects.toThrow(/resposta do MCP/); } finally { client.close(); }
  } finally { nullBody.server.stop(true); }

  const nullEvent = httpMock({ nullEvent: true });
  try {
    const client = await http(nullEvent.server, 2000);
    try { expect((await client.callTool("echo", {})).content[0]!.text).toBe("ação:2"); } finally { client.close(); }
  } finally { nullEvent.server.stop(true); }
});

test("transport http recompõe UTF-8 partido entre chunks", async () => {
  const { server } = httpMock({ splitUtf8: true });
  try {
    const client = await http(server, 2000);
    try {
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("ação:2"); // sem mojibake
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport sse rejeita pendência quando o POST falha com status", async () => {
  const posts: string[] = [];
  const streams: ((message: unknown) => void)[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET") {
        return new Response(
          new ReadableStream({
            start(controller) {
              const encode = new TextEncoder();
              controller.enqueue(encode.encode(`event: endpoint\ndata: /messages\n\n`));
              streams.push((message) => controller.enqueue(encode.encode(`data: ${JSON.stringify(message)}\n\n`)));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      posts.push(await new Response(req.body).text());
      return new Response(null, { status: posts.at(-1)!.includes("tools/call") ? 500 : 202 }); // só o tools/call falha
    },
  });
  try {
    const connectPromise = MCPClient.connect({ transport: "sse", url: `http://127.0.0.1:${server.port}/sse`, timeoutMs: 2000, enabled: true });
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    streams.forEach((send) => send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse", version: "1" } } }));
    const client = await connectPromise;
    try {
      await expect(client.callTool("echo", {})).rejects.toThrow(/HTTP 500 no MCP tools\/call/);
      // evento null no meio do stream não mata o transport: nova requisição responde com o id certo
      const toolsPromise = client.listTools();
      await new Promise((resolve) => setTimeout(resolve, 100)); // POST da tools/list chega ao servidor
      streams.forEach((send) => send(null));
      streams.forEach((send) => send({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "echo" }] } }));
      expect((await toolsPromise).map((tool) => tool.name)).toEqual(["echo"]);
    } finally { client.close(); }
  } finally {
    server.stop(true);
  }
});
