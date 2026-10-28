import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TEXT, parseCommand } from "../src/chat/commands";
import { runRepl, type ChatSession, type ReplIO } from "../src/chat/repl";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import { SessionStore } from "../src/chat/store";
import { nodeReplOptions } from "../src/chat/node-io";

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
  sent: string[] = [];
  async send(prompt: string): Promise<TurnResult> {
    this.sent.push(prompt);
    return {
      final: `eco:${prompt}`, model: this.model, steps: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
      totalTokensIn: 10 * this.sent.length, totalTokensOut: 5 * this.sent.length,
      totalCostUsd: 0.001 * this.sent.length, contextTokens: 10, contextLimit: 100, contextRatio: 0.1,
      warning: false, trimmed: false,
    };
  }
  clear(): void {}
  setModel(ref: string): string {
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1"];
  }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1"] }];
  }
  setProvider(name: string): string {
    return `${name}/m1`;
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }],
      turns: this.sent.length, tokensIn: 10 * this.sent.length, tokensOut: 5 * this.sent.length,
      costUsd: 0.001 * this.sent.length,
    };
  }
  close(): void {}
}

class CountingStore extends SessionStore {
  writes = 0;
  override write(snapshot: Parameters<SessionStore["write"]>[0]): string {
    this.writes++;
    return super.write(snapshot);
  }
}

describe("comandos de sessão e estilo do chat (T1.5, #173)", () => {
  test("parser e ajuda incluem /session e /save", () => {
    expect(parseCommand("/session")).toEqual({ kind: "session" });
    expect(parseCommand("/save")).toEqual({ kind: "save" });
    expect(HELP_TEXT).toContain("/session");
    expect(HELP_TEXT).toContain("/save");
  });

  test("/session mostra id, início, modelo, turnos, tokens, custo e arquivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-session-"));
    const io = new ScriptedIO(["olá", "/session", "/exit"]);
    await runRepl(new FakeSession(), io, { store: new SessionStore(dir) });
    const line = io.outputs.find((item) => item.startsWith("sessão s1"))!;
    expect(line).toContain("início 2026-10-28T12:00:00.000Z");
    expect(line).toContain("modelo p/m1");
    expect(line).toContain("turnos 1");
    expect(line).toContain("tokens 10/5");
    expect(line).toContain("custo US$ 0.001000");
    expect(io.outputs.some((item) => item.includes("arquivo:") && item.includes(dir))).toBe(true);
  });

  test("/save força a gravação e imprime o caminho existente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-save-"));
    const store = new CountingStore(dir);
    const io = new ScriptedIO(["/save", "/exit"]);
    await runRepl(new FakeSession(), io, { store });
    const saved = io.outputs.find((item) => item.startsWith("sessão salva em "))!;
    const path = saved.slice("sessão salva em ".length);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    expect(store.writes).toBe(2); // /save + fechamento
  });

  test("sem store, /save e /session avisam e não quebram", async () => {
    const io = new ScriptedIO(["/save", "/session", "/exit"]);
    await runRepl(new FakeSession(), io);
    expect(io.outputs).toContain("sem persistência configurada");
    expect(io.outputs.some((item) => item.startsWith("sessão s1"))).toBe(true);
  });

  test("cores ANSI só quando style está ligado", async () => {
    const plain = new ScriptedIO(["olá", "/exit"]);
    await runRepl(new FakeSession(), plain);
    expect(plain.outputs.some((item) => item.includes("\u001b["))).toBe(false);

    const colored = new ScriptedIO(["olá", "/exit"]);
    await runRepl(new FakeSession(), colored, { style: true });
    expect(colored.outputs.some((item) => item.includes("\u001b["))).toBe(true);
  });

  test("readline guarda histórico só em terminal", () => {
    expect(nodeReplOptions(true).historySize).toBeGreaterThanOrEqual(100);
    expect(nodeReplOptions(true).removeHistoryDuplicates).toBe(true);
    expect(nodeReplOptions(false).historySize).toBe(0);
  });

  test("falha de gravação vira erro e o REPL continua", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-savefail-"));
    const blocked = join(dir, "sessions");
    writeFileSync(blocked, "não é diretório");
    const io = new ScriptedIO(["/save", "olá", "/exit"]);
    const session = new FakeSession();
    await runRepl(session, io, { store: new SessionStore(blocked) });
    expect(io.outputs.some((item) => item.startsWith("erro:"))).toBe(true);
    expect(session.sent).toEqual(["olá"]); // não encerrou
  });
});
