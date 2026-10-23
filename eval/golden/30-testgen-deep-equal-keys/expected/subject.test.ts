import { describe, expect, test } from "bun:test";
import { keysSorted } from "./keys";

describe("keysSorted", () => {
  test("ordena chaves", () => {
    expect(keysSorted({ b: 1, a: 2 })).toEqual(["a", "b"]);
  });
  test("objeto vazio", () => {
    expect(keysSorted({})).toEqual([]);
  });
});
