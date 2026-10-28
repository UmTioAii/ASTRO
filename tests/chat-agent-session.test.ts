import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { AgentSession } from "../src/chat/agent-session";
import type { ChatMessage } from "../src/provider/types";
import { Ledger } from "../src/ledger";

interface Body { model?: string; messages?: ChatMessage[] }

function setup(opts: { context?: number; reply?: (call: number) => Response; budget?: Record<string, unknown> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-session-"));
  const bodies: Body[] = [];
  let call = 0;
  const server = Bun.serve({ port: 0, async fetch(req) {
    call++;
    bodies.push((await req.json()) as Body);
    return opts.reply?.(call) ?? final("ok");
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [
      { provider: "p", id: "m1", tags: ["writing-code"], context: opts.context ?? 8192,
        price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
      { provider: "p", id: "m2", tags: ["writing-code"], context: opts.context ?? 8192,
        price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
    ],
    agent: { model: "p/m1", maxSteps: 3, tools: [] },
    ...(opts.budget === undefined ? {} : { budget: opts.budget }),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return {
    cwd, configPath, bodies,
    session: (extra: Record<string, unknown> = {}) => new AgentSession({ configPath, cwd, env: { KEY: "k" }, systemPrompt: "sys", ...extra }),
    stop: () => server.stop(true),
  };
}

const final = (content: string, tin = 10, tout = 5): Response =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: tin, completion_tokens: tout } });

const toolCall = (): Response => Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
  function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

describe("AgentSession (T1, #62)", () => {
  test("multi-turn envia histórico e acumula tokens/custo no mesmo run", async () => {
    const { cwd, bodies, session, stop } = setup();
    const chat = session();
    try {
      const first = await chat.send("primeiro");
      expect(first.final).toBe("ok");
      expect(bodies[0]!.messages?.map((m) => m.content)).toEqual(["sys", "primeiro"]);
      const second = await chat.send("segundo");
      expect(second.totalTokensIn).toBe(20);
      expect(second.totalTokensOut).toBe(10);
      expect(bodies[1]!.messages?.map((m) => m.content)).toEqual(["sys", "primeiro", "ok", "segundo"]);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAll().filter((e) => e.run === chat.id)).toHaveLength(2);
      expect(chat.snapshot()).toMatchObject({ turns: 2, tokensIn: 20 });
      chat.clear();
      expect(chat.snapshot().turns).toBe(2); // acumulados da sessão continuam
      expect(chat.messages.map((m) => m.content)).toEqual(["sys"]);
    } finally {
      chat.close();
      stop();
    }
  });
  test("emite run.started/chat.prompt/run.completed por sessão (só taskHash)", async () => {
    const { cwd, session, stop } = setup();
    const chat = session();
    try {
      await chat.send("segredo do usuário");
      await chat.send("segundo");
      chat.close();
      chat.close();
      const events = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
      expect(events.filter((e) => e.tipo === "run.started")).toHaveLength(1);
      expect(events.filter((e) => e.tipo === "run.completed")).toHaveLength(1);
      expect(events.find((e) => e.tipo === "run.completed")?.payload).toMatchObject({ steps: 2, turns: 2, session: true });
      const prompts = events.filter((e) => e.tipo === "chat.prompt");
      expect(prompts).toHaveLength(2);
      expect((prompts[0]!.payload as { taskHash?: string }).taskHash).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(events)).not.toContain("segredo do usuário");
      const seqs = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll().map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      stop();
    }
  });
  test("troca de modelo em runtime chega ao próximo turno; inválido falha", async () => {
    const { bodies, session, stop } = setup();
    const chat = session();
    try {
      expect(chat.listModels()).toEqual(["p/m1", "p/m2"]);
      chat.setModel("p/m2");
      await chat.send("depois");
      expect(bodies[0]!.model).toBe("m2");
      expect(() => chat.setModel("p/ghost")).toThrow(/modelo/);
      expect(chat.snapshot().model).toBe("p/m2");
    } finally {
      chat.close();
      stop();
    }
  });
  test("context guard descarta o turno antigo no nível da sessão", async () => {
    const { bodies, session, stop } = setup({ context: 10 });
    const chat = session();
    try {
      await chat.send("a".repeat(20));
      const result = await chat.send("b".repeat(20));
      expect(result.warning).toBe(true);
      expect(result.trimmed).toBe(true);
      expect(bodies[1]!.messages?.map((m) => m.content)).not.toContain("a".repeat(20));
      expect(bodies[1]!.messages?.[0]).toEqual({ role: "system", content: "sys" });
    } finally {
      chat.close();
      stop();
    }
  });
  test("turno falho não entra no histórico, mas o custo gasto conta", async () => {
    const { session, stop } = setup({ reply: (call) => (call === 1 ? toolCall() : new Response("boom", { status: 400 })) });
    const chat = session();
    try {
      await expect(chat.send("falha")).rejects.toBeDefined();
      const snapshot = chat.snapshot();
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.turns).toBe(0);
      expect(snapshot.tokensIn).toBe(10); // uso da 1ª chamada não some
      expect(snapshot.costUsd).toBeGreaterThan(0);
    } finally {
      chat.close();
      stop();
    }
  });
  test("send concorrente e pós-close falham claro", async () => {
    const { session, stop } = setup();
    const chat = session();
    try {
      const results = await Promise.allSettled([chat.send("A"), chat.send("B")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      chat.close();
      await expect(chat.send("depois")).rejects.toThrow(/encerrada/);
    } finally {
      stop();
    }
  });
  test("budget negado encerra a sessão (sem segundo turno)", async () => {
    const { cwd, session, stop } = setup({ budget: { scope: "day", limitUsd: 0 } });
    const chat = session();
    try {
      await expect(chat.send("x")).rejects.toThrow(/budget/);
      await expect(chat.send("y")).rejects.toThrow(/encerrada/);
      chat.close();
      const completed = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll()
        .filter((e) => e.tipo === "run.completed");
      expect(completed).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
