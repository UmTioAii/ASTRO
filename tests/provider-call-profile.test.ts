import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallConfig } from "../src/call-profile";
import { CodexOAuthProvider } from "../src/provider/codex-oauth";
import { OpenAICompatProvider } from "../src/provider/openai-compat";

const call: CallConfig = {
  effort: {
    param: "reasoning.effort",
    map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "ultra" },
  },
  thinking: { mode: "toggle", param: "thinking.type", on: "enabled", off: "disabled" },
};

describe("call profile no corpo do provider (E1–E8)", () => {
  test("openai-compat envia effort e thinking aninhados e ecoa o perfil aplicado", async () => {
    let body: Record<string, unknown> = {};
    const provider = new OpenAICompatProvider({
      baseUrl: "http://mock/v1",
      call,
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          choices: [{ message: { content: "ok", reasoning_content: "texto de raciocínio" } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        });
      },
    });

    const res = await provider.complete({
      model: "m1",
      messages: [{ role: "user", content: "oi" }],
      call: { lvl: 4, thinking: "off" },
    });

    expect(body).toMatchObject({ model: "m1", reasoning: { effort: "ultra" }, thinking: { type: "disabled" } });
    expect(res.call).toEqual({ lvl: 4, effort: "ultra", thinking: "disabled", stripped: [] });
    expect(res.content).toBe("ok");
  });

  test("forbidden remove o param do corpo e zera o campo aplicado (E8)", async () => {
    let body: Record<string, unknown> = {};
    const provider = new OpenAICompatProvider({
      baseUrl: "http://mock/v1",
      call: { ...call, forbidden: ["reasoning.effort"] },
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });

    const res = await provider.complete({ model: "m1", messages: [{ role: "user", content: "oi" }], call: { lvl: 3 } });

    expect(body.reasoning).toBeUndefined();
    expect(res.call).toEqual({
      lvl: 3,
      thinking: "enabled",
      stripped: [{ name: "reasoning.effort", reason: "forbidden" }],
    });
  });

  test("Codex envia reasoning.effort no corpo /responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-codex-call-"));
    const authPath = join(dir, "auth.json");
    const exp = 9_999_999_999;
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: `h.${payload}.s`, refresh_token: "r", account_id: "acc" },
    }));

    let body: Record<string, unknown> = {};
    const provider = new CodexOAuthProvider({
      credentialsPath: authPath,
      now: () => 0,
      call,
      fetchFn: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const sse = [
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 6 } } })}`,
          "",
          "",
        ].join("\n");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });

    const res = await provider.complete({ model: "gpt-5.5", messages: [{ role: "user", content: "oi" }], call: { lvl: 3 } });

    expect(body).toMatchObject({ model: "gpt-5.5", reasoning: { effort: "high" } });
    expect(res.call).toMatchObject({ lvl: 3, effort: "high", thinking: "enabled" });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });
});
