import { expect, test } from "bun:test";
import { defaultArgs, isInteractive } from "../src/cli-default";

test("sem argumentos em terminal interativo abre a TUI", () => {
  expect(defaultArgs([], true)).toEqual(["tui"]);
});

test("sem argumentos em pipe imprime o help", () => {
  expect(defaultArgs([], false)).toEqual(["--help"]);
});

test("argumentos explícitos passam intactos", () => {
  expect(defaultArgs(["run", "oi"], true)).toEqual(["run", "oi"]);
  expect(defaultArgs(["run", "oi"], false)).toEqual(["run", "oi"]);
  expect(defaultArgs(["--help"], true)).toEqual(["--help"]);
  expect(defaultArgs(["--config", "x"], false)).toEqual(["--config", "x"]);
});

test("só é interativo com stdin e stdout em TTY", () => {
  expect(isInteractive(true, true)).toBe(true);
  expect(isInteractive(true, false)).toBe(false);
  expect(isInteractive(false, true)).toBe(false);
  expect(isInteractive(undefined, true)).toBe(false);
  expect(isInteractive(true, undefined)).toBe(false);
});

test("meio-TTY não abre a TUI", () => {
  expect(defaultArgs([], isInteractive(true, false))).toEqual(["--help"]);
  expect(defaultArgs([], isInteractive(false, true))).toEqual(["--help"]);
});
