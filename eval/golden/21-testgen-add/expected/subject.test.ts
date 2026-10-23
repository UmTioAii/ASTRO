import { describe, expect, test } from "bun:test";
import { add } from "./math";

describe("add", () => {
  test("soma positivos", () => {
    expect(add(1, 2)).toBe(3);
  });
  test("soma negativos", () => {
    expect(add(-1, -2)).toBe(-3);
  });
  test("zero é identidade", () => {
    expect(add(0, 5)).toBe(5);
  });
});
