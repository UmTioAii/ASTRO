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
    expect(trimmed).toEqual([sys, { role: "user", content: "atual" }, { role: "assistant", content: "resposta-atual" }]);
    expect(trimmed.map((m) => m.content)).not.toContain("resposta-antiga");
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

  test("funciona sem system no início (descarta o turno mais antigo mesmo assim)", () => {
    const messages = [...turn("u1", "a1"), ...turn("u2", "a2")];
    const trimmed = trimOldestTurn(messages)!;
    expect(trimmed.map((m) => m.content)).toEqual(["u2", "a2"]);
  });

  test("fronteiras exatas: 80% avisa, 100% não descarta, acima descarta", () => {
    const mini: ChatMessage = { role: "system", content: "x" }; // 1 token
    const at80 = [mini, { role: "user" as const, content: "a".repeat(20) }, { role: "assistant" as const, content: "b".repeat(8) }];
    expect(estimateMessagesTokens(at80)).toBe(8); // 8/10 exatos
    expect(guardContext(at80, 10).warning).toBe(true);
    const at100 = [mini, ...turn("u".repeat(8), "a".repeat(8)), { role: "user" as const, content: "c".repeat(20) }];
    expect(estimateMessagesTokens(at100)).toBe(10); // 10/10 exatos, com turno descartável
    const exact = guardContext(at100, 10);
    expect(exact.trimmed).toBe(false);
    expect(exact.messages.map((m) => m.content)).toContain("u".repeat(8));
    const over = [...at100.slice(0, -1), { role: "user" as const, content: "d".repeat(24) }];
    expect(guardContext(over, 10).trimmed).toBe(true);
  });

  test("context=0 avisa e descarta, sem ratio zerado", () => {
    const guard = guardContext([sys, ...turn("a".repeat(20), "b".repeat(20))], 0);
    expect(guard.warning).toBe(true);
    expect(guard.ratio).toBeGreaterThan(0);
  });
});
