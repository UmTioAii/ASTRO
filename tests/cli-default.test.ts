import { expect, test } from "bun:test";
import { defaultArgs } from "../src/cli-default";

test("sem argumentos em terminal interativo abre a TUI", () => {
  expect(defaultArgs([], true)).toEqual(["tui"]);
});

test("sem argumentos em pipe imprime o help", () => {
  expect(defaultArgs([], false)).toEqual(["--help"]);
});

test("argumentos explícitos passam intactos", () => {
  expect(defaultArgs(["run", "oi"], true)).toEqual(["run", "oi"]);
  expect(defaultArgs(["run", "oi"], false)).toEqual(["run", "oi"]);
});
