import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepl, type ChatSession, type ReplIO } from "../src/chat/repl";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import { BudgetExceededError } from "../src/budget";
import { SessionStore } from "../src/chat/store";

class ScriptedIO implements ReplIO {
  readonly outputs: string[] = [];
  constructor(private readonly lines: string[]) {}
  async read(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  write(text: string): void {
    this.outputs.push(text);
  }
}

class FakeSession implements ChatSession {
  model = "p/m1";
  readonly sent: string[] = [];
  cleared = 0;
  closed = 0;
  fail = 0;
  fatal: Error | undefined;
  clearedFlag = false;
  async send(prompt: string): Promise<TurnResult> {
    this.sent.push(prompt);
    if (this.fail > 0) {
      this.fail--;
      throw new Error("boom");
    }
    if (this.fatal !== undefined) throw this.fatal;
    return {
      final: `eco:${prompt}`, model: this.model, steps: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
      totalTokensIn: 10 * this.sent.length, totalTokensOut: 5 * this.sent.length, totalCostUsd: 0.001,
      contextTokens: 10, contextLimit: 100, contextRatio: 0.1, warning: false, trimmed: false,
    };
  }
  clear(): void {
    this.cleared++;
    this.clearedFlag = true;
  }
  setModel(ref: string): string {
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1", "p/m2"];
  }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1", "m2"] }];
  }
  setProvider(name: string): string {
    if (name !== "p") throw new Error(`provider "${name}" não tem modelo ativo`);
    this.model = `${name}/m1`;
    return this.model;
  }
  resumed: SessionSnapshot[] = [];
  resume(snapshot: SessionSnapshot): void {
    this.resumed.push(snapshot);
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: this.clearedFlag ? [{ role: "system", content: "sys" }] : [{ role: "user", content: "x" }],
      turns: this.sent.length, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
    };
  }
  close(): void {
    this.closed++;
  }
}

describe("REPL do chat (T1, #62)", () => {
  test("roteia prompt, comandos, status e persistência", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-repl-"));
    const session = new FakeSession();
    const io = new ScriptedIO(["olá", "/clear", "/model", "/model p/m2", "/providers", "/provider p", "/help", "/nope", "/exit"]);
    await runRepl(session, io, { store: new SessionStore(dir) });
    expect(session.sent).toEqual(["olá"]);
    expect(session.cleared).toBe(1);
    expect(session.model).toBe("p/m1");
    expect(session.closed).toBe(1);
    expect(io.outputs).toContain("eco:olá");
    expect(io.outputs.some((line) => line.includes("1 step(s)") && line.includes("US$"))).toBe(true);
    expect(io.outputs).toContain("contexto limpo");
    expect(io.outputs).toContain("modelo: p/m2");
    expect(io.outputs.some((line) => line.includes("p (openai-compat)") && line.includes("cred=KEY"))).toBe(true);
    expect(io.outputs).toContain("provider: p/m1");
    expect(io.outputs.some((line) => line.includes("/exit"))).toBe(true);
    expect(io.outputs.some((line) => line.includes("comando desconhecido: /nope"))).toBe(true);




    expect(readdirSync(dir).some((name) => name.endsWith(".json"))).toBe(true);
  });
  test("erro de turno não encerra; erro fatal encerra", async () => {
    const ok = new FakeSession();
    ok.fail = 1;
    const io = new ScriptedIO(["a", "b", "/exit"]);
    await runRepl(ok, io);
    expect(ok.sent).toEqual(["a", "b"]);
    expect(io.outputs).toContain("erro: boom");

    const fatal = new FakeSession();
    fatal.fatal = new Error("wrapped", { cause: new BudgetExceededError("limit", {} as never) });
    const io2 = new ScriptedIO(["a", "nunca"]);
    await runRepl(fatal, io2);
    expect(fatal.sent).toEqual(["a"]);
    expect(fatal.closed).toBe(1);
  });
  test("persiste o estado final após /clear sem novo turno", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-repl-final-"));
    const session = new FakeSession();
    await runRepl(session, new ScriptedIO(["olá", "/clear"]), { store: new SessionStore(dir) });
    const file = readdirSync(dir).find((name) => name.endsWith(".json"))!;
    const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as { messages: unknown[] };
    expect(record.messages).toEqual([{ role: "system", content: "sys" }]);
  });
  test("EOF encerra e fecha a sessão", async () => {
    const session = new FakeSession();
    await runRepl(session, new ScriptedIO([]));
    expect(session.closed).toBe(1);
  });

  test("/sessions lista e /resume retoma pelo número", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-resume-"));
    new SessionStore(dir).write({
      id: "abc", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "velho" }], turns: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
    });
    const session = new FakeSession();
    const io = new ScriptedIO(["/sessions", "/resume 1", "/exit"]);
    await runRepl(session, io, { store: new SessionStore(dir) });
    expect(io.outputs.some((line) => line.includes("abc"))).toBe(true);
    expect(session.resumed).toHaveLength(1);
    expect(session.resumed[0]!.messages[0]!.content).toBe("velho");
    expect(io.outputs).toContain("sessão retomada: abc (1 turnos)");
  });
  test("/resume 1 sem /sessions recarrega a lista; índice inválido avisa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-resume2-"));
    new SessionStore(dir).write({
      id: "xyz", startedAt: "2026-10-02T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "guardado" }], turns: 2, tokensIn: 20, tokensOut: 10, costUsd: 0.002,
    });
    const session = new FakeSession();
    const io = new ScriptedIO(["/resume 1", "/resume 9", "/exit"]);
    await runRepl(session, io, { store: new SessionStore(dir) });
    expect(io.outputs).toContain("sessão retomada: xyz (2 turnos)");
    expect(io.outputs).toContain("índice fora da lista; use /sessions");
    expect(session.resumed).toHaveLength(1);
  });
  test("/export grava Markdown e /init cria AGENTS.md no cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-repl-export-"));
    const io = new ScriptedIO(["/export", "/export notas/s.md", "/init", "/init", "/exit"]);
    await runRepl(new FakeSession(), io, { cwd });
    expect(io.outputs.some((line) => line.includes("sessão exportada em") && line.includes(".astro"))).toBe(true);
    expect(existsSync(join(cwd, "notas", "s.md"))).toBe(true);
    expect(io.outputs.some((line) => line.includes("AGENTS.md criado em"))).toBe(true);
    expect(io.outputs.some((line) => line.startsWith("erro:") && line.includes("já existe"))).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
  });
});
