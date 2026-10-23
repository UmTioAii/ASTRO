import { describe, expect, test } from "bun:test";
import { countWords } from "./words";

describe("countWords", () => {
  test("conta palavras", () => {
    expect(countWords("um dois três")).toBe(3);
  });
  test("string vazia", () => {
    expect(countWords("")).toBe(0);
  });
});
