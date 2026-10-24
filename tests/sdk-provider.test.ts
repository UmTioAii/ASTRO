import { describe, expect, test } from "bun:test";
import {
  ProviderError,
  createMockProvider,
  defineProviderFactory,
  mockResponse,
  mockToolCall,
  type CompletionRequest,
} from "../src/sdk/provider";
import { ollamaFactory } from "../examples/provider-ollama/ollama";

const req = (p: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "m",
  messages: [{ role: "user", content: "oi" }],
  ...p,
});

describe("provider SDK (F7-2)", () => {
  test("superfície pública: tipos e ProviderError re-exportados", () => {
    const err = new ProviderError("auth", "x", 401);
    expect(err.errClass).toBe("auth");
    expect(err.status).toBe(401);
  });

  test("createMockProvider: consome script em ordem e registra calls", async () => {
    const provider = createMockProvider([
      mockResponse({ content: "primeira" }),
      mockResponse({ content: "segunda" }),
    ]);
    expect((await provider.complete(req())).content).toBe("primeira");
    expect((await provider.complete(req())).content).toBe("segunda");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.messages[0]!.content).toBe("oi");
  });

  test("createMockProvider: esgotado repete a última resposta", async () => {
    const provider = createMockProvider([mockResponse({ content: "única" })]);
    await provider.complete(req());
    await provider.complete(req());
    expect((await provider.complete(req())).content).toBe("única");
  });

  test("createMockProvider: erro no script é lançado (útil p/ testar retry)", async () => {
    const provider = createMockProvider([
      new ProviderError("transient_rate_limit", "limite", 429),
      mockResponse({ content: "ok" }),
    ]);
    const err = await provider.complete(req()).then(() => null, (e) => e as ProviderError);
    expect(err!).toBeInstanceOf(ProviderError);
    expect(err!.errClass).toBe("transient_rate_limit");
    expect((await provider.complete(req())).content).toBe("ok");
  });

  test("mockToolCall + mockResponse compõem respostas com tools", async () => {
    const call = mockToolCall("write_file", { path: "a.txt", content: "x" });
    const provider = createMockProvider([mockResponse({ toolCalls: [call] })]);
    const response = await provider.complete(req());
    expect(response.toolCalls[0]!.name).toBe("write_file");
    expect(JSON.parse(response.toolCalls[0]!.arguments)).toEqual({ path: "a.txt", content: "x" });
  });

  test("defineProviderFactory: kind + create no formato de plugin", async () => {
    const factory = defineProviderFactory("eco", (rawConfig) => {
      const prefix = String(rawConfig.prefix ?? "");
      return {
        async complete(r) {
          return mockResponse({ content: `${prefix}${r.model}` });
        },
      };
    });
    expect(factory.kind).toBe("eco");
    const provider = factory.create({ prefix: "eco:" }, {});
    expect((await provider.complete(req({ model: "x" }))).content).toBe("eco:x");
  });
});

describe("exemplo provider-ollama (F7-2)", () => {
  function ollamaServer(handler: () => Response) {
    const server = Bun.serve({
      port: 0,
      async fetch(r): Promise<Response> {
        const url = new URL(r.url);
        if (r.method === "POST" && url.pathname === "/v1/chat/completions") return handler();
        return new Response("nope", { status: 404 });
      },
    });
    return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
  }

  test("complete() contra Ollama mock: content, tool calls e usage", async () => {
    const server = ollamaServer(() =>
      Response.json({
        choices: [{ message: { content: "olá do ollama", tool_calls: [{ function: { name: "write_file", arguments: "{\"path\":\"a\"}" } }] } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    try {
      const provider = ollamaFactory.create({ baseUrl: server.baseUrl }, {});
      const response = await provider.complete(req({ model: "llama3" }));
      expect(response.content).toBe("olá do ollama");
      expect(response.toolCalls[0]!.name).toBe("write_file");
      expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    } finally {
      server.stop();
    }
  });

  test("401 → ProviderError auth; rede morta → outage", async () => {
    const server = ollamaServer(() => new Response("unauthorized", { status: 401 }));
    try {
      const provider = ollamaFactory.create({ baseUrl: server.baseUrl }, {});
      const err = await provider.complete(req()).then(() => null, (e) => e as ProviderError);
      expect(err!).toBeInstanceOf(ProviderError);
      expect(err!.errClass).toBe("auth");
    } finally {
      server.stop();
    }

    const dead = ollamaFactory.create({ baseUrl: "http://127.0.0.1:1/v1" }, {});
    const err2 = await dead.complete(req()).then(() => null, (e) => e as ProviderError);
    expect(err2!).toBeInstanceOf(ProviderError);
    expect(err2!.errClass).toBe("outage");
  });
});
