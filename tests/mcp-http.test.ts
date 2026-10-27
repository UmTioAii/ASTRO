import { expect, test } from "bun:test";
import { MCPClient } from "../src/mcp/client";

/** Servidor MCP streamable HTTP de mentira: POST JSON-RPC responde JSON simples. */
function httpServer(opts: { delayMs?: number; stream?: boolean; non2xx?: boolean } = {}) {
  const posts: { method: string; id: number }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; id: number };
      posts.push({ method: body.method, id: body.id });
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-mock", version: "1" } } }, { headers: { "mcp-session-id": "sess-1" } });
      }
      if (opts.non2xx === true) return new Response(null, { status: 500 });
      if (req.headers.get("mcp-session-id") !== "sess-1") return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "sessão inválida" } }, { status: 404 });
      if (body.method === "tools/list") {
        if (opts.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", description: "Eco HTTP" }] } });
      }
      if (opts.stream === true) {
        const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `http:${body.id}` }] } });
        return new Response(`data: keep-alive textual\n\ndata: ${message}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `http:${body.id}` }] } });
    },
  });
  return { server, posts };
}

/** Servidor MCP SSE legacy: GET abre o stream e envia o endpoint; POST recebe 202; respostas vêm pelo stream. */
function sseServer() {
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
              controller.enqueue(encode.encode(`event: endpoint\ndata: /messages?session=abc\n\n`));
              streams.push((message) => controller.enqueue(encode.encode(`data: ${JSON.stringify(message)}\n\n`)));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      posts.push(await new Response(req.body).text());
      return new Response(null, { status: 202 });
    },
  });
  const respond = (message: unknown) => streams.forEach((send) => send(message));
  return { server, posts, respond };
}

const http = (server: { port?: number }, timeoutMs: number) =>
  MCPClient.connect({ transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs, enabled: true });
const sse = (server: { port?: number }, timeoutMs: number) =>
  MCPClient.connect({ transport: "sse", url: `http://127.0.0.1:${server.port}/sse`, timeoutMs, enabled: true });

test("transport http conecta, mantém sessão e chama tools", async () => {
  const { server, posts } = httpServer();
  try {
    const client = await http(server, 2000);
    try {
      expect(client.serverInfo.name).toBe("http-mock");
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      expect((await client.callTool("echo", {})).content[0]!.text).toBe(`http:3`);
      expect(posts.map((post) => post.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    } finally { client.close(); }
    await expect(MCPClient.connect({ transport: "http", url: "http://127.0.0.1:1/mcp", timeoutMs: 300, enabled: true })).rejects.toThrow(/timeout|falha/);
  } finally { server.stop(true); }
});

test("transport http sobrevive a timeout de requisição sem matar o transport", async () => {
  const { server } = httpServer({ delayMs: 600 });
  try {
    const client = await http(server, 200);
    try {
      await expect(client.listTools()).rejects.toThrow(/timeout/);
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("http:3"); // recupera após o timeout
      client.close(); await expect(client.callTool("echo", {})).rejects.toThrow(/fechado/);
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport http reporta HTTP não-2xx com o status", async () => {
  const { server } = httpServer({ non2xx: true });
  try {
    const client = await http(server, 2000);
    try {
      await expect(client.listTools()).rejects.toThrow(/HTTP 500 no MCP tools\/list/);
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport http tolera evento data não-JSON no stream de resposta", async () => {
  const { server } = httpServer({ stream: true });
  try {
    const client = await http(server, 2000);
    try {
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("http:2");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport sse conecta via endpoint e recebe respostas pelo stream", async () => {
  const { server, posts, respond } = sseServer();
  try {
    const connectPromise = sse(server, 2000);
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    respond({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse-mock", version: "1" } } });
    const client = await connectPromise;
    try {
      expect(client.serverInfo.name).toBe("sse-mock");
      respond({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "echo" }] } });
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      respond({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "sse-ok" }] } });
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("sse-ok");
      expect(posts.every((body) => body.includes("jsonrpc"))).toBe(true);
    } finally { client.close(); }
    await expect(MCPClient.connect({ transport: "sse", url: "http://127.0.0.1:1/sse", timeoutMs: 300, enabled: true })).rejects.toThrow(/timeout|falha/);
  } finally { server.stop(true); }
});
