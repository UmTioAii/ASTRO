import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/provider/types";
import {
  countMessageTokens,
  countRequestTokens,
  estimateTokens,
  hasTokenizer,
  registerTokenizer,
  unregisterTokenizer,
} from "../src/tokens";

const user = (content: string): ChatMessage => ({ role: "user", content });

beforeEach(() => {
  for (const provider of ["native", "native-2", "other"]) unregisterTokenizer(provider);
});

describe("contagem de tokens por provider (S-19, D-21)", () => {
  test("estimativa determinística: 4 chars/token, nunca zero para texto não vazio", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    const text = "uma mensagem de teste com acentuação";
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  test("mensagens vazias são zero; texto vira estimate marcado", () => {
    expect(countMessageTokens([])).toEqual({ tokens: 0, source: "estimate" });
    const count = countMessageTokens([user("abcd")]);
    expect(count.source).toBe("estimate");
    expect(count.tokens).toBeGreaterThan(0);
  });

  test("tokenizer nativo registrado por provider é medido; outro provider estima", () => {
    registerTokenizer("native", (text) => text.length, "native-test");
    expect(hasTokenizer("native")).toBe(true);
    expect(hasTokenizer("other")).toBe(false);

    const measured = countMessageTokens([user("abcd")], { provider: "native" });
    expect(measured).toMatchObject({ tokens: 4, source: "measured" });
    expect(measured.tokenizer).toBe("native-test");

    const estimated = countMessageTokens([user("abcd")], { provider: "other" });
    expect(estimated.source).toBe("estimate");
    expect(estimated.tokens).toBeGreaterThan(0);
  });

  test("conta conteúdo, tool calls e definições de tools da request", () => {
    const messages: ChatMessage[] = [
      user("oi"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"x\"}" }],
      },
      { role: "tool", content: "resultado", toolCallId: "c1" },
    ];
    const withoutTools = countRequestTokens({ model: "m1", messages });
    const withTools = countRequestTokens({
      model: "m1",
      messages,
      tools: [{ name: "read_file", description: "lê arquivo", parameters: { type: "object" } }],
    });
    expect(withoutTools.tokens).toBeGreaterThan(0);
    expect(withTools.tokens).toBeGreaterThan(withoutTools.tokens);
    expect(countRequestTokens({ model: "m1", messages })).toEqual(withoutTools);
  });

  test("tokenizer que devolve zero para texto não vazio falha em vez de reportar grátis", () => {
    registerTokenizer("native", () => 0, "broken");
    expect(() => countMessageTokens([user("abcd")], { provider: "native" })).toThrow(/contagem inválida/);

    // Sem tokenizer, o provider volta à estimativa documentada e nunca a zero.
    unregisterTokenizer("native");
    expect(countMessageTokens([user("abcd")], { provider: "native" }))
      .toEqual({ tokens: 1, source: "estimate" });
  });

  test("troca de tokenizer entre providers não afeta os demais", () => {
    registerTokenizer("native", (text) => text.length, "a");
    registerTokenizer("native-2", (text) => text.length * 2, "b");
    expect(countMessageTokens([user("abcd")], { provider: "native" }).tokens).toBe(4);
    expect(countMessageTokens([user("abcd")], { provider: "native-2" }).tokens).toBe(8);
    expect(countMessageTokens([user("abcd")], { provider: "other" }).source).toBe("estimate");
  });
});
