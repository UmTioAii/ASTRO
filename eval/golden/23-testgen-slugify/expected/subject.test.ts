import { describe, expect, test } from "bun:test";
import { slugify } from "./slug";

describe("slugify", () => {
  test("minúsculas e hífens", () => {
    expect(slugify("Olá Mundo")).toBe("olá-mundo");
  });
  test("remove espaços nas bordas", () => {
    expect(slugify("  x  ")).toBe("x");
  });
});
