import { describe, expect, test } from "bun:test";
import { OpenAICompatProvider } from "../src/provider/openai-compat";
import type { CompletionRequest } from "../src/provider/types";

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function providerWith(chunks: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse(chunks);
    },
  });
  return { provider, bodies };
}

const base: CompletionRequest = { model: "m1", messages: [{ role: "user", content: "oi" }] };

describe("streaming SSE do openai-compat (T3, #64)", () => {
  test("entrega deltas, consolida conteúdo e usage, e pede stream", async () => {
    const deltas: string[] = [];
    const { provider, bodies } = providerWith([
      'data: {"choices":[{"delta":{"content":"olá "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"mundo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const response = await provider.complete({ ...base, onToken: (text) => deltas.push(text) });
    expect(deltas).toEqual(["olá ", "mundo"]);
    expect(response.content).toBe("olá mundo");
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(bodies[0]!.stream).toBe(true);
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true });
  });

  test("acumula tool calls fatiadas", async () => {
    const deltas: string[] = [];
    const { provider } = providerWith([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const response = await provider.complete({ ...base, onToken: (text) => deltas.push(text) });
    expect(deltas).toEqual([]);
    expect(response.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" }]);
  });

  test("sem onToken mantém o corpo JSON sem stream", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatProvider({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    const response = await provider.complete(base);
    expect(response.content).toBe("ok");
    expect(bodies[0]!.stream).toBeUndefined();
  });


test("não repete a chamada depois de emitir token", async () => {
  let calls = 0;
  const deltas: string[] = [];
  const provider = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    fetchFn: async () => {
      calls++;
      return sse([
        'data: {"choices":[{"delta":{"content":"oi"}}]}\n\n',
        "data: {quebrado\n\n",
      ]);
    },
  });
  await expect(provider.complete({ ...base, onToken: (text) => deltas.push(text) })).rejects.toThrow(/stream/);
  expect(calls).toBe(1);
  expect(deltas).toEqual(["oi"]);
});

test("200 não-SSE cai no parser normal mesmo com onToken", async () => {
  const deltas: string[] = [];
  const provider = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    fetchFn: async () => Response.json({ choices: [{ message: { content: "json" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  });
  const response = await provider.complete({ ...base, onToken: (text) => deltas.push(text) });
  expect(response.content).toBe("json");
  expect(deltas).toEqual([]);
});

test("frame de erro e stream vazio viram ProviderError", async () => {
  const failing = providerWith(['data: {"error":{"message":"quota"}}\n\n']).provider;
  await expect(failing.complete({ ...base, onToken: () => {} })).rejects.toThrow(/stream do provider: quota/);

  const empty = providerWith([]).provider;
  await expect(empty.complete({ ...base, onToken: () => {} })).rejects.toThrow(/streaming vazia/);
});

test("frame de erro redige segredo e tool calls paralelas id-first", async () => {
  const leaking = new OpenAICompatProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "real-secret-key-value",
    fetchFn: async () => sse(['data: {"error":{"message":"chave sk-live-SEGREDO123"}}\n\n']),
  });
  const error = await leaking.complete({ ...base, onToken: () => {} }).then(() => null, (e: Error) => e);
  expect(String(error?.message)).not.toContain("sk-live-SEGREDO123");

  const { provider } = providerWith([
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}},{"id":"c2","function":{"name":"write_file","arguments":"{\\"x"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}},{"index":1,"function":{"arguments":"\\":1}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const response = await provider.complete({ ...base, onToken: () => {} });
  expect(response.toolCalls).toEqual([
    { id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" },
    { id: "c2", name: "write_file", arguments: "{\"x\":1}" },
  ]);
});

test("fragmentos sem index com id repetido ou sem id continuam na mesma call", async () => {
  const repeated = providerWith([
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]).provider;
  const withId = await repeated.complete({ ...base, onToken: () => {} });
  expect(withId.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" }]);

  const anonymous = providerWith([
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]).provider;
  const withoutId = await anonymous.complete({ ...base, onToken: () => {} });
  expect(withoutId.toolCalls).toEqual([{ id: "call_0", name: "read_file", arguments: "{\"path\":\"a\"}" }]);
});});
