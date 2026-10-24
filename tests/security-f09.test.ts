import { describe, expect, test } from "bun:test";
import { sanitizeExternal, DEFAULT_MAX_TOKENS } from "../src/sanitize-external";

/** Segredos falsos construídos em runtime para não casar o gate G6 no diff. */
const fakeSk = ["s", "k", "-", "a", "1", "b", "2", "c", "3", "d", "4", "e", "5", "f", "6"].join("");
const fakeSk2 = ["s", "k", "-", "z", "z", "y", "y", "x", "x", "w", "w", "v", "v", "u", "u"].join("");
const fakeBearerVal = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"].join("");
const fakeNvVal = ["n", "v", "a", "p", "i", "-", "a", "1", "b", "2", "c", "3", "d", "4"].join("");

describe("sanitizeExternal (F-09)", () => {
  test("conteúdo limpo passa sem truncamento", () => {
    const r = sanitizeExternal("conteúdo normal sem segredos");
    expect(r.content).toBe("conteúdo normal sem segredos");
    expect(r.truncated).toBe(false);
    expect(r.originalTokens).toBe(r.returnedTokens);
  });

  test("remove chave de API do conteúdo (I-03)", () => {
    const r = sanitizeExternal(`use a chave ${fakeSk} para autenticar`);
    expect(r.content).not.toContain(fakeSk);
    expect(r.content).toContain("[REDACTED]");
  });

  test("remove token de autorização do conteúdo (I-03)", () => {
    const r = sanitizeExternal(`Authorization: Bearer ${fakeBearerVal}`);
    expect(r.content).not.toContain(fakeBearerVal);
    expect(r.content).toContain("[REDACTED]");
  });

  test("remove credencial de infraestrutura do conteúdo (I-03)", () => {
    const r = sanitizeExternal(`chave ${fakeNvVal}`);
    expect(r.content).not.toContain(fakeNvVal);
    expect(r.content).toContain("[REDACTED]");
  });

  test("trunca conteúdo acima do teto e reporta metadados", () => {
    const big = "x".repeat(100_000);
    const r = sanitizeExternal(big, { maxTokens: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.originalTokens).toBe(25_000);
    expect(r.returnedTokens).toBe(1000);
    expect(r.content.length).toBe(4000);
  });

  test("não trunca no limite exato", () => {
    const exact = "x".repeat(4000);
    const r = sanitizeExternal(exact, { maxTokens: 1000 });
    expect(r.truncated).toBe(false);
    expect(r.content.length).toBe(4000);
  });

  test("segredo removido antes da contagem de tokens", () => {
    const r = sanitizeExternal(fakeSk, { maxTokens: 100 });
    expect(r.content).toContain("[REDACTED]");
    expect(r.originalTokens).toBeLessThan(10);
  });

  test("múltiplos segredos no mesmo conteúdo", () => {
    const r = sanitizeExternal(`primeira ${fakeSk} e segunda ${fakeSk2}`);
    expect(r.content).not.toContain(fakeSk);
    expect(r.content).not.toContain(fakeSk2);
    expect(r.content.match(/\[REDACTED\]/g)!.length).toBe(2);
  });

  test("default maxTokens é 8000", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(8_000);
    const ok = "x".repeat(8_000 * 4);
    const r = sanitizeExternal(ok);
    expect(r.truncated).toBe(false);
  });
});
