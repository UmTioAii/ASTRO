import { describe, expect, test } from "bun:test";
import { clamp } from "./clamp";

describe("clamp", () => {
  test("dentro do intervalo", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  test("abaixo do mínimo", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  test("acima do máximo", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
