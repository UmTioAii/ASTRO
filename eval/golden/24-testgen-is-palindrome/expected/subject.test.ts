import { describe, expect, test } from "bun:test";
import { isPalindrome } from "./palindrome";

describe("isPalindrome", () => {
  test("palíndromo simples", () => {
    expect(isPalindrome("ovo")).toBe(true);
  });
  test("ignora maiúsculas e pontuação", () => {
    expect(isPalindrome("A base do teto desaba")).toBe(true);
  });
  test("não palíndromo", () => {
    expect(isPalindrome("abc")).toBe(false);
  });
});
