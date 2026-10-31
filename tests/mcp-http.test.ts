import { expect, test } from "bun:test";
import { MCPClient } from "../src/mcp/client";

/** Servidor MCP streamable HTTP de mentira: POST JSON-RPC responde JSON simples. */
function httpServer(opts: { delayMs?: number; stream?: boolean; non2xx?: boolean; badData?: boolean; utf8Stream?: boolean; errorNull?: boolean } = {}) {
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
      if (opts.errorNull === true) {
        const result = { content: [{ type: "text", text: `http:${body.id}` }] };
        if (opts.stream === true) {
          return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result, error: null })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result, error: null });
      }
      if (opts.utf8Stream === true) {
        const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "café-日本" }] } })}\n\n`;
        const bytes = new TextEncoder().encode(frame);
        const at = bytes.findIndex((byte, index) => byte === 0xc3 && bytes[index + 1] === 0xa9);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, at + 1));
              // segundo chunk em outro tick: garante que o transporte veja dois chunks (não coalescidos)
              setTimeout(() => controller.enqueue(bytes.slice(at + 1)), 15);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (opts.stream === true) {
        const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `http:${body.id}` }] } });
        const garbage = opts.badData === true ? "data: null\n\ndata: []\n\ndata: 42\n\n" : "";
        return new Response(`${garbage}data: ${message}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `http:${body.id}` }] } });
    },
  });
  return { server, posts };
}

/** Servidor MCP SSE legacy: GET abre o stream e envia o endpoint; POST recebe 202; respostas vêm pelo stream. */
function sseServer(opts: { postStatus?: number; splitUtf8?: boolean; endpoint?: string } = {}) {
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
              controller.enqueue(encode.encode(`event: endpoint\ndata: ${opts.endpoint ?? "/messages?session=abc"}\n\n`));
              streams.push((message) => {
                const frame = `data: ${JSON.stringify(message)}\n\n`;
                if (opts.splitUtf8 === true) {
                  const bytes = encode.encode(frame);
                  const at = bytes.findIndex((byte, index) => byte === 0xc3 && bytes[index + 1] === 0xa9);
                  if (at >= 0) {
                    controller.enqueue(bytes.slice(0, at + 1));
                    // segundo chunk em outro tick: garante que o transporte veja dois chunks (não coalescidos)
                    setTimeout(() => controller.enqueue(bytes.slice(at + 1)), 15);
                    return;
                  }
                }
                controller.enqueue(encode.encode(frame));
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      posts.push(await new Response(req.body).text());
      return new Response(null, { status: opts.postStatus ?? 202 });
    },
  });
  const respond = (message: unknown) => streams.forEach((send) => send(message));
  return { server, posts, respond };
}

const http = (server: { port?: number }, timeoutMs: number) =>
  MCPClient.connect({ transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs, enabled: true });
const sse = (server: { port?: number }, timeoutMs: number) =>
  MCPClient.connect({ transport: "sse", url: `http://127.0.0.1:${server.port}/sse`, timeoutMs, enabled: true });

/**
 * Contrato de ordem dos POSTs: `initialize` primeiro; os POSTs com id seguem
 * `initialize` -> `tools/list` -> `tools/call`; a notificação
 * `notifications/initialized` (fire-and-forget) aparece exatamente uma vez em
 * qualquer posição, inclusive depois de `tools/call`, porque a gravação no mock
 * depende do parse concorrente. Quatro POSTs exatos: nada de retry.
 */
function expectValidPostOrder(methods: string[]): void {
  expect(methods).toHaveLength(4);
  expect(methods.filter((method) => method !== "notifications/initialized"))
    .toEqual(["initialize", "tools/list", "tools/call"]);
  expect(methods.filter((method) => method === "notifications/initialized")).toHaveLength(1);
}

test("ordem dos POSTs aceita notificação fire-and-forget em qualquer posição", () => {
  expect(() => expectValidPostOrder(["initialize", "tools/list", "notifications/initialized", "tools/call"])).not.toThrow();
  expect(() => expectValidPostOrder(["initialize", "notifications/initialized", "tools/list", "tools/call"])).not.toThrow();
  expect(() => expectValidPostOrder(["initialize", "tools/list", "tools/call", "notifications/initialized"])).not.toThrow();
  expect(() => expectValidPostOrder(["initialize", "tools/list", "tools/call"])).toThrow();
  expect(() => expectValidPostOrder(["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call"])).toThrow();
  expect(() => expectValidPostOrder(["initialize", "tools/call", "notifications/initialized", "tools/list"])).toThrow();
  expect(() => expectValidPostOrder(["tools/list", "initialize", "notifications/initialized", "tools/call"])).toThrow();
  expect(() => expectValidPostOrder(["initialize", "notifications/initialized", "notifications/initialized", "tools/call"])).toThrow();
});

test("transport http conecta, mantém sessão e chama tools", async () => {
  const { server, posts } = httpServer();
  try {
    const client = await http(server, 2000);
    try {
      expect(client.serverInfo.name).toBe("http-mock");
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      expect((await client.callTool("echo", {})).content[0]!.text).toBe(`http:3`);
      expectValidPostOrder(posts.map((post) => post.method));
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

test("transport http ignora data null, array e número no stream sem derrubar a resposta", async () => {
  const { server } = httpServer({ stream: true, badData: true });
  try {
    const client = await http(server, 2000);
    try {
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("http:2");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport sse ignora data null sem encerrar o stream", async () => {
  const { server, posts, respond } = sseServer();
  try {
    const connectPromise = sse(server, 2000);
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    respond({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse-mock", version: "1" } } });
    const client = await connectPromise;
    try {
      respond(null);
      respond({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "sse-ok" }] } });
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("sse-ok");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport sse preserva UTF-8 dividido entre chunks", async () => {
  const { server, posts, respond } = sseServer({ splitUtf8: true });
  try {
    const connectPromise = sse(server, 2000);
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    respond({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse-mock", version: "1" } } });
    const client = await connectPromise;
    try {
      respond({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "café-日本" }] } });
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("café-日本");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport sse rejeita POST não-2xx com o status sem esperar timeout", async () => {
  const { server, posts } = sseServer({ postStatus: 500 });
  try {
    // `.then` em vez de `expect(...).rejects`: no bun/win32 a rejeição antecipada vira unhandled antes do matcher
    const outcome = sse(server, 2000).then(
      () => "resolveu",
      (error: Error) => error.message,
    );
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await outcome).toMatch(/HTTP 500/);
  } finally { server.stop(true); }
});

test("transport sse rejeita endpoint de outra origem sem enviar POST com auth", async () => {
  const seen: (string | null)[] = [];
  const other = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(req.headers.get("authorization"));
      return new Response(null, { status: 202 });
    },
  });
  const { server } = sseServer({ endpoint: `http://127.0.0.1:${other.port}/messages` });
  try {
    // `.then` em vez de `expect(...).rejects`: no bun/win32 a rejeição antecipada vira unhandled antes do matcher
    const outcome = MCPClient.connect({
      transport: "sse",
      url: `http://127.0.0.1:${server.port}/sse`,
      headers: { Authorization: "env:MCP_TOKEN" },
      timeoutMs: 2000,
      enabled: true,
    }, { MCP_TOKEN: "Bearer tok-250" }).then(
      () => "resolveu",
      (error: Error) => error.message,
    );
    expect(await outcome).toMatch(/origem/);
    expect(seen).toEqual([]);
  } finally {
    server.stop(true);
    other.stop(true);
  }
});

test("transport http preserva UTF-8 dividido entre chunks", async () => {
  const { server } = httpServer({ utf8Stream: true });
  try {
    const client = await http(server, 2000);
    try {
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("café-日本");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport http trata error null como sucesso", async () => {
  const { server } = httpServer({ errorNull: true });
  try {
    const client = await http(server, 2000);
    try {
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("http:2");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport http trata error null no stream como sucesso", async () => {
  const { server } = httpServer({ errorNull: true, stream: true });
  try {
    const client = await http(server, 2000);
    try {
      expect((await client.callTool("echo", {})).content[0]!.text).toBe("http:2");
    } finally { client.close(); }
  } finally { server.stop(true); }
});

test("transport sse trata error null como sucesso", async () => {
  const { server, posts, respond } = sseServer();
  try {
    const connectPromise = sse(server, 2000);
    for (let attempt = 0; attempt < 20 && posts.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    respond({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse-mock", version: "1" } } });
    const client = await connectPromise;
    try {
      // `error: null` é usado por servidores no sucesso; não pode pendurar a chamada
      const outcome = client.callTool("echo", {}).then(
        (result) => result.content[0]!.text,
        (error: Error) => `erro: ${error.message}`,
      );
      respond({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "sse-ok" }] }, error: null });
      expect(await Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve("pendurou"), 500))])).toBe("sse-ok");
    } finally { client.close(); }
  } finally { server.stop(true); }
});
