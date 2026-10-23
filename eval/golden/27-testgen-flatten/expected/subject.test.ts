import { describe, expect, test } from "bun:test";
import { flatten } from "./flatten";

describe("flatten", () => {
  test("achata aninhados", () => {
    expect(flatten([1, [2, [3]]])).toEqual([1, 2, 3]);
  });
  test("já plano", () => {
    expect(flatten([1, 2])).toEqual([1, 2]);
  });
});
