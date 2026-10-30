import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseCommand } from "../src/chat/commands";
import { detailsLines, formatUptime } from "../src/chat/repl";
import type { SessionSnapshot } from "../src/chat/agent-session";

describe("comandos do chat (T1, #62)", () => {
  test("texto normal vira prompt; vazio é ignorado", () => {
    expect(parseCommand("  olá mundo  ")).toEqual({ kind: "prompt", text: "olá mundo" });
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });
  test("aliases de saída e ajuda", () => {
    for (const line of ["/exit", "/quit", "/q", "/EXIT"]) expect(parseCommand(line)).toEqual({ kind: "exit" });
    expect(parseCommand("/help")).toEqual({ kind: "help" });

  });
  test("/model sem arg lista; com arg troca; desconhecido nomeia", () => {
    expect(parseCommand("/model")).toEqual({ kind: "model" });
    expect(parseCommand("/model p/m2")).toEqual({ kind: "model", model: "p/m2" });
    expect(parseCommand("/nope a")).toEqual({ kind: "unknown", raw: "nope" });
  });
  test("/providers e /provider", () => {
    expect(parseCommand("/providers")).toEqual({ kind: "providers" });
    expect(parseCommand("/provider")).toEqual({ kind: "provider", action: "list" });
    expect(parseCommand("/provider list")).toEqual({ kind: "provider", action: "list" });
    expect(parseCommand("/provider add")).toEqual({ kind: "provider", action: "add" });
    expect(parseCommand("/provider add OpenAI Work")).toEqual({
      kind: "provider", action: "add", target: "OpenAI Work",
    });
    expect(parseCommand("/provider edit openai-work")).toEqual({
      kind: "provider", action: "edit", target: "openai-work",
    });
    expect(parseCommand("/provider remove openai-work")).toEqual({
      kind: "provider", action: "remove", target: "openai-work",
    });
    expect(parseCommand("/provider use openai-work")).toEqual({
      kind: "provider", action: "use", target: "openai-work",
    });
    expect(parseCommand("/provider q")).toEqual({ kind: "provider", action: "use", target: "q" });
    expect(parseCommand("/provider use")).toEqual({ kind: "provider", action: "use" });
    expect(parseCommand("/provider edit")).toEqual({ kind: "provider", action: "edit" });
  });
  test("ajuda lista os quatro comandos", () => {
    for (const command of ["/help", "/model", "/clear", "/exit"]) expect(HELP_TEXT).toContain(command);
  });


  test("/sessions e /resume", () => {
    expect(parseCommand("/sessions")).toEqual({ kind: "sessions" });
    expect(parseCommand("/resume")).toEqual({ kind: "resume" });
    expect(parseCommand("/resume 2")).toEqual({ kind: "resume", ref: "2" });
  });

  test("/export e /init", () => {
    expect(parseCommand("/export")).toEqual({ kind: "export" });
    expect(parseCommand("/export notas.md")).toEqual({ kind: "export", path: "notas.md" });
    expect(parseCommand("/init")).toEqual({ kind: "init" });
  });


  test("/new é alias de /clear", () => {
    expect(parseCommand("/new")).toEqual({ kind: "clear" });
  });

  test("/details é reconhecido (argumentos extra são ignorados)", () => {
    expect(parseCommand("/details")).toEqual({ kind: "details" });
    expect(parseCommand("/details x")).toEqual({ kind: "details" });
  });

  test("detailsLines inclui todos os campos e retoma", () => {
    const snap: SessionSnapshot = {
      id: "abc", startedAt: "2026-10-28T12:00:00.000Z", model: "p/m2",
      messages: [], turns: 3, tokensIn: 30, tokensOut: 15, costUsd: 0.004,
      resumedFrom: { id: "xyz", startedAt: "2026-10-27T10:00:00.000Z" },
    };
    const lines = detailsLines(snap, "/tmp/s.json", new Date("2026-10-28T12:05:00.000Z").getTime());
    const text = lines.join("\n");
    expect(text).toContain("sessão abc");
    expect(text).toContain("uptime 5m");
    expect(text).toContain("provider: p");
    expect(text).toContain("modelo p/m2");
    expect(text).toContain("turnos 3");
    expect(text).toContain("tokens 30/15");
    expect(text).toContain("custo US$ 0.004000");
    expect(text).toContain("retomada de xyz");
    expect(text).toContain("arquivo: /tmp/s.json");
  });

  test("formatUptime cobre segundos, minutos, horas", () => {
    const base = new Date("2026-10-28T12:00:00.000Z").getTime();
    expect(formatUptime("2026-10-28T12:00:00.000Z", base)).toBe("0s");
    expect(formatUptime("2026-10-28T11:59:30.000Z", base)).toBe("30s");
    expect(formatUptime("2026-10-28T11:59:00.000Z", base)).toBe("1m");
    expect(formatUptime("2026-10-28T11:58:30.000Z", base)).toBe("1m 30s");
    expect(formatUptime("2026-10-28T11:00:00.000Z", base)).toBe("1h");
    expect(formatUptime("2026-10-28T10:30:00.000Z", base)).toBe("1h 30m");
    expect(formatUptime("não-data", base)).toBe("desconhecido");
  });

  test("/compact e /summarize são reconhecidos", () => {
    expect(parseCommand("/compact")).toEqual({ kind: "compact" });
    expect(parseCommand("/summarize")).toEqual({ kind: "compact" });
    expect(parseCommand("/compact extra")).toEqual({ kind: "compact" });
    expect(parseCommand("/summarize extra")).toEqual({ kind: "compact" });
    expect(parseCommand("/compact force")).toEqual({ kind: "compact", force: true });
    expect(parseCommand("/summarize FORCE")).toEqual({ kind: "compact", force: true });
  });
});
