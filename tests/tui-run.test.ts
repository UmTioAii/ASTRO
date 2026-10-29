import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config";
import { openSession } from "../src/tui/run";
import { saveTuiConfig } from "../src/tui/theme";

const tempCwd = (): string => mkdtempSync(join(tmpdir(), "astro-tui-boot-"));

describe("bootstrap da TUI (T2, #197)", () => {
  test("aplica o modelo gravado; inválido cai no default; outros erros propagam", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const seen: Array<string | undefined> = [];
    expect(openSession((saved) => { seen.push(saved); return saved ?? "default"; }, cwd)).toBe("p/m2");
    expect(seen).toEqual(["p/m2"]);

    saveTuiConfig(cwd, { lastModel: "p/ghost" });
    const fallback = openSession((saved) => {
      if (saved === "p/ghost") throw new ConfigError("modelo desconhecido");
      return saved ?? "p/m1";
    }, cwd);
    expect(fallback).toBe("p/m1");
    expect(() => openSession(() => { throw new Error("boom"); }, tempCwd())).toThrow("boom");
  });
});
