import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/provider/types";
import { estimateMessagesTokens, guardContext, trimOldestTurn } from "../src/chat/context-guard";

const sys: ChatMessage = { role: "system", content: "system" };
const turn = (user: string, assistant: string): ChatMessage[] => [
  { role: "user", content: user },
  { role: "assistant", content: assistant },
];

describe("context guard do chat (T1, #62)", () => {
  test("estima tokens por conteúdo e tool calls", () => {
    expect(estimateMessagesTokens([{ role: "user", content: "12345678" }])).toBe(2);
    const withCall: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", arguments: "{}" }] };
    expect(estimateMessagesTokens([withCall])).toBeGreaterThan(0);
  });

  test("avisa em 80% e não mexe abaixo disso", () => {
    const messages = [sys, ...turn("a".repeat(20), "b".repeat(20))];
    const guard = guardContext(messages, 100);
    expect(guard.warning).toBe(false);
    expect(guard.trimmed).toBe(false);
    const tight = guardContext(messages, 10);
    expect(tight.warning).toBe(true);
  });

  test("acima de 100% descarta o turno mais antigo inteiro, preservando o system", () => {
    const messages = [sys, ...turn("antigo", "resposta-antiga"), ...turn("atual", "resposta-atual")];
    const trimmed = trimOldestTurn(messages)!;
    expect(trimmed[0]).toEqual(sys);
    expect(trimmed.map((m) => m.content)).not.toContain("antigo");
    expect(trimmed.map((m) => m.content)).toContain("atual");

    const guard = guardContext(messages, 1);
    expect(guard.messages[0]).toEqual(sys);
    expect(guard.messages.map((m) => m.content)).not.toContain("antigo");
    expect(guard.messages.map((m) => m.content)).toContain("atual");
    expect(guard.trimmed).toBe(true);
    expect(guard.warning).toBe(true);
  });

  test("nunca remove o turno atual (sem turno anterior inteiro)", () => {
    const messages = [sys, ...turn("único", "r")];
    expect(trimOldestTurn(messages)).toBeNull();
    const guard = guardContext(messages, 1);
    expect(guard.messages.map((m) => m.content)).toContain("único");
    expect(guard.trimmed).toBe(false);
  });
});
