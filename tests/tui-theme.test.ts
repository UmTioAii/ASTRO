import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThemeColors, loadTuiConfig, nextTheme, saveTuiConfig } from "../src/tui/theme";

const tempCwd = (): string => mkdtempSync(join(tmpdir(), "astro-tui-theme-"));

describe("configuração da TUI (T2, #197)", () => {
  test("sem arquivo ou JSON inválido cai no tema dark", () => {
    expect(loadTuiConfig(tempCwd())).toEqual({ theme: "dark" });
    const broken = tempCwd();
    mkdirSync(join(broken, ".astro"));
    writeFileSync(join(broken, ".astro", "tui.json"), "{", "utf8");
    expect(loadTuiConfig(broken)).toEqual({ theme: "dark" });
  });

  test("salva tema e último modelo preservando um ao outro", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { theme: "light" });
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    expect(loadTuiConfig(cwd)).toEqual({ theme: "light", lastModel: "p/m2" });
    expect(nextTheme("light")).toBe("dark");
    expect(getThemeColors("dark").accent).toBe("cyan");
  });

  test("salva e carrega favoritos e recentes, ignorando entradas inválidas", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, {
      favoriteModels: ["p/a", "p/a", "", "p/b"],
      recentModels: ["p/c", "p/c", "p/d"],
    });
    expect(loadTuiConfig(cwd)).toEqual({
      theme: "dark",
      favoriteModels: ["p/a", "p/b"],
      recentModels: ["p/c", "p/d"],
    });

    const broken = tempCwd();
    mkdirSync(join(broken, ".astro"));
    writeFileSync(join(broken, ".astro", "tui.json"), JSON.stringify({
      theme: "light",
      favoriteModels: ["p/a", 1, "", "p/a"],
      recentModels: "p/b",
    }), "utf8");
    expect(loadTuiConfig(broken)).toEqual({ theme: "light", favoriteModels: ["p/a"] });
  });

  test("recusa .astro que escapa do cwd (I-11)", () => {
    const cwd = tempCwd();
    symlinkSync(tempCwd(), join(cwd, ".astro"), process.platform === "win32" ? "junction" : "dir");
    expect(() => saveTuiConfig(cwd, { theme: "light" })).toThrow();
    expect(loadTuiConfig(cwd)).toEqual({ theme: "dark" });
  });
});
