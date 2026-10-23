import { describe, expect, test } from "bun:test";
import { percent } from "./percent";

describe("percent", () => {
  test("metade", () => {
    expect(percent(50, 100)).toBe(50);
  });
  test("total zero lança", () => {
    expect(() => percent(1, 0)).toThrow("total zero");
  });
});
