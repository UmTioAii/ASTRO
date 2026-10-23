import { expect, test } from "bun:test";
import { OpenAICompatProvider } from "../src/provider/openai-compat";
import { ProviderError, type CompletionRequest } from "../src/provider/types";

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const req = { model: "gpt-4o-mini", messages: [{ role: "user" as const, content: "oi" }] };

test("parseia resposta com conteúdo, tool calls e usage", async () => {
  const fetchFn = async () =>
    ok({
      choices: [{ message: { content: "oi!", tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn });
  const r = await p.complete(req);
  expect(r.content).toBe("oi!");
  expect(r.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }]);
  expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
});

test("mapeia erros para as 5 classes", async () => {
  const cases: Array<[number, string, string]> = [
    [429, "insufficient_quota", "hard_quota"],
    [429, "rate limited", "transient_rate_limit"],
    [401, "", "auth"],
    [400, "bad request", "invalid_request"],
    [500, "boom", "outage"],
  ];
  for (const [status, body, cls] of cases) {
    const fetchFn = async () => ok({ error: { message: body } }, status);
    const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn, retry: { maxAttempts: 1 } });
    const err = (await p.complete(req).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.errClass).toBe(cls as ProviderError["errClass"]);
  }
});

test("200 sem choices → outage", async () => {
  const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn: async () => ok({ id: "x" }), retry: { maxAttempts: 1 } });
  const err = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.errClass).toBe("outage");
});

test("chave só no header e nunca em erro", async () => {
  let seen = "";
  const fetchFn = async (_url: string, init?: RequestInit) => {
    seen = String(new Headers(init?.headers).get("authorization"));
    return ok({ error: { message: "no" } }, 401);
  };
  const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "sk-secret12345678", fetchFn });
  const err = (await p.complete(req).catch((e) => e)) as ProviderError;
  expect(seen).toBe("Bearer sk-secret12345678");
  expect(String(err.message)).not.toContain("sk-secret12345678");
});

test("normaliza tool-call IDs numéricos e ausentes", async () => {
  const fetchFn = async () =>
    ok({
      choices: [{ message: { content: "", tool_calls: [
        { id: 42, type: "function", function: { name: "read_file", arguments: "{}" } },
        { type: "function", function: { name: "write_file", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn, retry: { maxAttempts: 1 } });
  const r = await p.complete(req);
  expect(r.toolCalls[0].id).toBe("42");
  expect(typeof r.toolCalls[1].id).toBe("string");
  expect(r.toolCalls[1].id.length).toBeGreaterThan(0);
});

test("retry básico: 429 seguido de sucesso", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return calls === 1
      ? ok({ error: { message: "rate" } }, 429)
      : ok({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn, retry: { maxAttempts: 2, windowMs: 1000 } });
  const r = await p.complete(req);
  expect(r.content).toBe("ok");
  expect(calls).toBe(2);
});

test("mapeia request: URL, headers extras, mensagens e tools", async () => {
  let seenUrl = "";
  let seenHeaders = new Headers();
  let seenBody: Record<string, unknown> = {};
  const fetchFn = async (url: string, init?: RequestInit) => {
    seenUrl = url;
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return ok({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  const p = new OpenAICompatProvider({
    baseUrl: "http://x/v1/",
    apiKey: "k",
    headers: { "HTTP-Referer": "https://astro.local", "X-Title": "astro" },
    fetchFn,
  });

  await p.complete({
    model: "gpt-4o-mini",
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }] },
      { role: "tool", content: "conteúdo", toolCallId: "c1" },
    ],
    tools: [{ name: "read_file", description: "lê um arquivo", parameters: { type: "object" } }],
  });

  expect(seenUrl).toBe("http://x/v1/chat/completions");
  expect(seenHeaders.get("authorization")).toBe("Bearer k");
  expect(seenHeaders.get("content-type")).toBe("application/json");
  expect(seenHeaders.get("http-referer")).toBe("https://astro.local");
  expect(seenHeaders.get("x-title")).toBe("astro");
  expect(seenBody).toEqual({
    model: "gpt-4o-mini",
    messages: [
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", content: "conteúdo", tool_call_id: "c1" },
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "lê um arquivo", parameters: { type: "object" } } }],
  });
});

test("normaliza papel developer → system no request", async () => {
  let seenBody: Record<string, unknown> = {};
  const fetchFn = async (_url: string, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return ok({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
  };
  const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", apiKey: "k", fetchFn });
  const messages = [{ role: "developer", content: "seja breve" }] as unknown as CompletionRequest["messages"];
  await p.complete({ model: "m", messages });
  expect(seenBody.messages).toEqual([{ role: "system", content: "seja breve" }]);
});

test("falha de rede e JSON inválido → outage", async () => {
  const network = new OpenAICompatProvider({
    baseUrl: "http://x/v1",
    apiKey: "k",
    fetchFn: async () => {
      throw new Error("ECONNRESET");
    },
    retry: { maxAttempts: 1 },
  });
  const networkErr = (await network.complete(req).catch((e) => e)) as ProviderError;
  expect(networkErr).toBeInstanceOf(ProviderError);
  expect(networkErr.errClass).toBe("outage");

  const invalid = new OpenAICompatProvider({
    baseUrl: "http://x/v1",
    apiKey: "k",
    fetchFn: async () => new Response("não é json", { status: 200 }),
    retry: { maxAttempts: 1 },
  });
  const invalidErr = (await invalid.complete(req).catch((e) => e)) as ProviderError;
  expect(invalidErr).toBeInstanceOf(ProviderError);
  expect(invalidErr.errClass).toBe("outage");
});

test("erros não transitórios não retentam (403/404/422 inclusos)", async () => {
  const cases: Array<[number, string, string]> = [
    [429, "insufficient_quota", "hard_quota"],
    [401, "", "auth"],
    [403, "forbidden", "auth"],
    [400, "bad request", "invalid_request"],
    [404, "not found", "invalid_request"],
    [422, "unprocessable", "invalid_request"],
  ];
  for (const [status, body, cls] of cases) {
    let calls = 0;
    const p = new OpenAICompatProvider({
      baseUrl: "http://x/v1",
      apiKey: "k",
      fetchFn: async () => {
        calls++;
        return ok({ error: { message: body } }, status);
      },
      retry: { maxAttempts: 3, windowMs: 1000 },
    });
    const err = (await p.complete(req).catch((e) => e)) as ProviderError;
    expect(err.errClass).toBe(cls as ProviderError["errClass"]);
    expect(calls).toBe(1);
  }
});
