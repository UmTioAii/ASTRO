import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexOAuthProvider } from "../src/provider/codex-oauth";
import { ProviderError } from "../src/provider/types";

const jwt = (payload: object) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

const sse = (events: object[]) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const authPath = (exp: number) => {
  const path = join(mkdtempSync(join(tmpdir(), "astro-codex-")), "auth.json");
  writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt({ exp }), refresh_token: "r1", account_id: "acct_1" } }));
  return path;
};

test("monta texto e tool calls a partir do SSE", async () => {
  let seen: RequestInit | undefined;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    seen = init;
    return sse([
      { type: "response.output_text.delta", delta: "o" },
      { type: "response.output_text.delta", delta: "i" },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", call_id: "c1", delta: "{\"path\":\"a.txt\"}" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
  };
  const p = new CodexOAuthProvider({ credentialsPath: authPath(4102444800), fetchFn });
  const r = await p.complete({ model: "gpt-5.5", messages: [{ role: "user", content: "oi" }] });
  expect(r.content).toBe("oi");
  expect(r.toolCalls[0]).toMatchObject({ id: "c1", name: "read_file" });
  expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  expect(new Headers(seen?.headers).get("chatgpt-account-id")).toBe("acct_1");
});

test("token expirado → refresh antes da chamada", async () => {
  let refreshed = false;
  const fetchFn = async (url: string) => {
    if (url.includes("/oauth/token")) {
      refreshed = true;
      return Response.json({ access_token: jwt({ exp: 4102444800 }), refresh_token: "r2" });
    }
    return sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  };
  const p = new CodexOAuthProvider({ credentialsPath: authPath(1), fetchFn });
  await p.complete({ model: "gpt-5.5", messages: [{ role: "user", content: "oi" }] });
  expect(refreshed).toBe(true);
});

test("refresh negado → ProviderError auth", async () => {
  const fetchFn = async (_url: string) => new Response("no", { status: 401 });
  const p = new CodexOAuthProvider({ credentialsPath: authPath(1), fetchFn });
  const err = (await p
    .complete({ model: "m", messages: [{ role: "user", content: "oi" }] })
    .catch((e) => e)) as ProviderError;
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.errClass).toBe("auth");
});

test("erro HTTP não vaza o access token", async () => {
  const path = authPath(4102444800);
  const token = (JSON.parse(readFileSync(path, "utf8")) as { tokens: { access_token: string } }).tokens.access_token;
  const fetchFn = async () =>
    new Response(JSON.stringify({ error: { message: `token ${token} recusado` } }), { status: 401 });
  const p = new CodexOAuthProvider({ credentialsPath: path, fetchFn });
  const err = (await p
    .complete({ model: "m", messages: [{ role: "user", content: "oi" }] })
    .catch((e) => e)) as ProviderError;
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.errClass).toBe("auth");
  expect(err.message).not.toContain(token);
});

test("classifica 429 e 5xx nas mesmas classes", async () => {
  const cases = [
    { status: 429, body: '{"error":{"code":"insufficient_quota"}}', errClass: "hard_quota" },
    { status: 429, body: "rate limited", errClass: "transient_rate_limit" },
    { status: 500, body: "boom", errClass: "outage" },
  ] as const;

  for (const entry of cases) {
    const fetchFn = async () => new Response(entry.body, { status: entry.status });
    const p = new CodexOAuthProvider({ credentialsPath: authPath(4102444800), fetchFn });
    const err = (await p
      .complete({ model: "m", messages: [{ role: "user", content: "oi" }] })
      .catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.errClass).toBe(entry.errClass);
  }
});

test("SSE inválido → outage", async () => {
  const fetchFn = async () => new Response("data: {oops\n\n", { status: 200 });
  const p = new CodexOAuthProvider({ credentialsPath: authPath(4102444800), fetchFn });
  const err = (await p
    .complete({ model: "m", messages: [{ role: "user", content: "oi" }] })
    .catch((e) => e)) as ProviderError;
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.errClass).toBe("outage");
});

test("refresh não reescreve auth.json", async () => {
  const path = authPath(1);
  const before = readFileSync(path, "utf8");
  const fetchFn = async (url: string) => {
    if (url.includes("/oauth/token")) {
      return Response.json({ access_token: jwt({ exp: 4102444800 }), refresh_token: "r2" });
    }
    return sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  };
  const p = new CodexOAuthProvider({ credentialsPath: path, fetchFn });
  await p.complete({ model: "m", messages: [{ role: "user", content: "oi" }] });
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("usa baseUrl customizado e mapeia a conversa", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchFn = async (target: string, init?: RequestInit) => {
    url = target;
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sse([{ type: "response.completed", response: { usage: {} } }]);
  };
  const p = new CodexOAuthProvider({
    credentialsPath: authPath(4102444800),
    baseUrl: "http://127.0.0.1:9/v1/",
    headers: { originator: "astro" },
    fetchFn,
  });
  const r = await p.complete({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "seja breve" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" }] },
      { role: "tool", content: "conteúdo", toolCallId: "c1" },
    ],
    tools: [{ name: "read_file", description: "lê", parameters: { type: "object" } }],
  });
  expect(url).toBe("http://127.0.0.1:9/v1/responses");
  expect(headers.get("originator")).toBe("astro");
  expect(headers.get("authorization")?.startsWith("Bearer ")).toBe(true);
  expect(body.stream).toBe(true);
  expect(body.instructions).toBe("seja breve");
  expect(body.tools).toEqual([
    { type: "function", name: "read_file", description: "lê", parameters: { type: "object" } },
  ]);
  expect(body.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "oi" }] },
    { type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" },
    { type: "function_call_output", call_id: "c1", output: "conteúdo" },
  ]);
  expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});
