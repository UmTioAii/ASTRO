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
  for (const provider of ["native", "native-2", "other", " openai "]) unregisterTokenizer(provider);
});

describe("contagem de tokens por provider (S-19, D-22)", () => {
  test("estimativa documentada: 4 chars/token, determinística e nunca zero para texto não vazio", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    const text = "uma mensagem de teste com acentuação";
    expect(estimateTokens(text)).toBe(9);
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  test("mensagens vazias são zero; texto vira estimate marcado", () => {
    expect(countMessageTokens([])).toEqual({ tokens: 0, source: "estimate" });
    const count = countMessageTokens([user("abcd")]);
    expect(count).toEqual({ tokens: 1, source: "estimate" });
    expect(countMessageTokens([user("abcde")])).toEqual({ tokens: 2, source: "estimate" });
  });

  test("tokenizer nativo registrado por provider é medido; outro provider estima", () => {
    registerTokenizer("native", (text) => text.length, "native-test");
    expect(hasTokenizer("native")).toBe(true);
    expect(hasTokenizer("other")).toBe(false);

    const measured = countMessageTokens([user("abcd")], { provider: "native" });
    expect(measured).toMatchObject({ tokens: 4, source: "measured" });
    expect(measured.tokenizer).toBe("native-test");

    const estimated = countMessageTokens([user("abcd")], { provider: "other" });
    expect(estimated).toEqual({ tokens: 1, source: "estimate" });
  });

  test("a chave do provider é normalizada em registro, consulta e remoção", () => {
    registerTokenizer(" openai ", (text) => text.length, "spaced");
    expect(hasTokenizer("openai")).toBe(true);
    expect(hasTokenizer(" openai ")).toBe(true);
    expect(countMessageTokens([user("abcd")], { provider: "openai" }))
      .toMatchObject({ tokens: 4, source: "measured" });

    unregisterTokenizer(" openai ");
    expect(hasTokenizer("openai")).toBe(false);
    expect(countMessageTokens([user("abcd")], { provider: "openai" }).source).toBe("estimate");

    expect(() => registerTokenizer("   ", () => 1)).toThrow(/provider vazio/);
    expect(hasTokenizer("   ")).toBe(false);
    expect(() => unregisterTokenizer("   ")).not.toThrow();
  });

  test("registro é idempotente: o último tokenizer do provider vence", () => {
    registerTokenizer("native", (text) => text.length, "first");
    registerTokenizer("native", (text) => text.length * 2, "second");
    expect(countMessageTokens([user("abcd")], { provider: "native" })).toMatchObject({
      tokens: 8,
      source: "measured",
      tokenizer: "second",
    });
  });

  test("conta conteúdo, toolCallId, tool calls e definições de tools da request", () => {
    const messages: ChatMessage[] = [
      user("ab"), // 2
      {
        role: "assistant",
        content: "", // vazio não conta
        toolCalls: [{ id: "i", name: "nm", arguments: "a" }], // 1 + 2 + 1
      },
      { role: "tool", content: "r", toolCallId: "t" }, // 1 + 1
    ];
    registerTokenizer("native", (text) => text.length, "chars");

    expect(countMessageTokens(messages, { provider: "native" })).toEqual({
      tokens: 8,
      source: "measured",
      tokenizer: "chars",
    });
    expect(countRequestTokens({
      model: "m1",
      messages,
      tools: [{ name: "n", description: "d", parameters: {} }], // 1 + 1 + 2 ("{}")
    }, { provider: "native" })).toEqual({ tokens: 12, source: "measured", tokenizer: "chars" });
  });

  test("tokenizer que devolve zero, negativo ou não finito falha em vez de reportar grátis", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      registerTokenizer("native", () => value, "broken");
      expect(() => countMessageTokens([user("abcd")], { provider: "native" })).toThrow(/contagem inválida/);
    }

    // Sem tokenizer, o provider volta à estimativa documentada e nunca a zero.
    unregisterTokenizer("native");
    expect(countMessageTokens([user("abcd")], { provider: "native" }))
      .toEqual({ tokens: 1, source: "estimate" });
  });

  test("registro rejeita tokenizer que não é função e nome vazio usa a chave", () => {
    expect(() => registerTokenizer("native", undefined as unknown as (text: string) => number))
      .toThrow(/deve ser uma função/);
    expect(hasTokenizer("native")).toBe(false);

    registerTokenizer(" native ", (text) => text.length);
    expect(countMessageTokens([user("abcd")], { provider: "native" }))
      .toEqual({ tokens: 4, source: "measured", tokenizer: "native" });
  });

  test("parâmetros de tool não serializáveis não derrubam a contagem", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const pieces = countRequestTokens({
      model: "m1",
      messages: [user("oi")],
      tools: [{ name: "t", description: "d", parameters: circular }],
    });
    expect(pieces.tokens).toBeGreaterThan(0);
    expect(pieces.source).toBe("estimate");
  });

  test("troca de tokenizer entre providers não afeta os demais", () => {
    registerTokenizer("native", (text) => text.length, "a");
    registerTokenizer("native-2", (text) => text.length * 2, "b");
    expect(countMessageTokens([user("abcd")], { provider: "native" }).tokens).toBe(4);
    expect(countMessageTokens([user("abcd")], { provider: "native-2" }).tokens).toBe(8);
    expect(countMessageTokens([user("abcd")], { provider: "other" }).source).toBe("estimate");
    expect(hasTokenizer("other")).toBe(false);
  });

  test("mesma entrada produz a mesma contagem (determinismo)", () => {
    const messages: ChatMessage[] = [user("mensagem estável"), { role: "assistant", content: "resposta" }];
    const request = {
      model: "m1",
      messages,
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    };
    expect(countRequestTokens(request)).toEqual(countRequestTokens(request));
    expect(countMessageTokens(messages)).toEqual(countMessageTokens([...messages]));
  });
});
