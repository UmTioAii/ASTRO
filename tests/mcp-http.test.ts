import { expect, test } from "bun:test";
import { MCPClient } from "../src/mcp/client";
import type { MCPServerConfig } from "../src/config";

/** Servidor MCP streamable HTTP de mentira: POST JSON-RPC responde JSON simples. */
function httpServer() {
  const posts: { method: string; id: number }[] = [];
  let session = "sess-1";
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method: string; id: number };
      posts.push({ method: body.method, id: body.id });
      if (body.method === "initialize") {
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-mock", version: "1" } } },
          { headers: { "mcp-session-id": session } },
        );
      }
      if (req.headers.get("mcp-session-id") !== session) return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "sessão inválida" } }, { status: 404 });
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", description: "Eco HTTP" }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `http:${body.id}` }] } });
    },
  });
  return { server, posts, renewSession: () => { session = `sess-${posts.length}`; } };
}

test("transport http conecta, mantém sessão e chama tools", async () => {
  const { server, posts } = httpServer();
  try {
    const client = await MCPClient.connect({ transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs: 2000, enabled: true });
    try {
      expect(client.serverInfo.name).toBe("http-mock");
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      expect((await client.callTool("echo", {})).content[0]!.text).toBe(`http:3`);
      expect(posts.map((post) => post.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    } finally {
      client.close();
    }
    await expect(MCPClient.connect({ transport: "http", url: "http://127.0.0.1:1/mcp", timeoutMs: 300, enabled: true })).rejects.toThrow(/timeout|falha/);
  } finally {
    server.stop(true);
  }
});

/** Servidor MCP SSE legacy: GET /sse abre o stream e envia o endpoint; POST recebe 202; respostas vêm pelo stream. */
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
              const send = (message: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
              controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: /messages?session=abc\n\n`));
              streams.push(send);
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

test("transport sse conecta via endpoint e recebe respostas pelo stream", async () => {
  const { server, posts, respond } = sseServer();
  try {
    const connectPromise = MCPClient.connect({ transport: "sse", url: `http://127.0.0.1:${server.port}/sse`, timeoutMs: 2000, enabled: true });
    // Responde o initialize quando chegar ao endpoint (polling leve pelo POST)
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    respond({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse-mock", version: "1" } } });
    const client = await connectPromise;
    try {
      expect(client.serverInfo.name).toBe("sse-mock");
      respond({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "echo" }] } });
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      respond({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "sse-ok" }] } });
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("sse-ok");
      expect(posts.every((body) => body.includes("jsonrpc"))).toBe(true);
    } finally {
      client.close();
    }
    await expect(MCPClient.connect({ transport: "sse", url: "http://127.0.0.1:1/sse", timeoutMs: 300, enabled: true })).rejects.toThrow(/timeout|falha/);
  } finally {
    server.stop(true);
  }
});

