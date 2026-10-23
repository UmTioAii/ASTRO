import { describe, expect, test } from "bun:test";
import { chunk } from "./chunk";

describe("chunk", () => {
  test("divide em blocos", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  test("lista vazia", () => {
    expect(chunk([], 3)).toEqual([]);
  });
});
