import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThemeColors, loadTuiConfig, nextTheme, saveTuiConfig } from "../src/tui/theme";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "astro-tui-theme-"));
}

describe("configuração da TUI (T2, #197)", () => {
  test("sem arquivo, o tema é dark", () => {
    expect(loadTuiConfig(tempCwd())).toEqual({ theme: "dark" });
  });

  test("JSON inválido ou tema desconhecido cai no default", () => {
    const broken = tempCwd();
    mkdirSync(join(broken, ".astro"));
    writeFileSync(join(broken, ".astro", "tui.json"), "{", "utf8");
    expect(loadTuiConfig(broken)).toEqual({ theme: "dark" });

    const invalid = tempCwd();
    mkdirSync(join(invalid, ".astro"));
    writeFileSync(join(invalid, ".astro", "tui.json"), JSON.stringify({ theme: "neon" }), "utf8");
    expect(loadTuiConfig(invalid)).toEqual({ theme: "dark" });
  });

  test("salva tema e último modelo preservando um ao outro", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { theme: "light" });
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    expect(loadTuiConfig(cwd)).toEqual({ theme: "light", lastModel: "p/m2" });

    const raw = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { theme: string };
    expect(raw.theme).toBe("light");
  });

  test("nextTheme alterna e getThemeColors muda o destaque", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(getThemeColors("dark").accent).toBe("cyan");
    expect(getThemeColors("light").accent).toBe("blue");
  });
});
