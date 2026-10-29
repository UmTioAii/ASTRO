import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTuiConfig } from "../src/tui/theme";
import { applySavedModel } from "../src/tui/run";

describe("bootstrap da TUI (T2, #197)", () => {
  test("aplica o último modelo gravado", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-tui-boot-"));
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const applied: string[] = [];
    const model = applySavedModel({ setModel: (ref) => { applied.push(ref); return ref; } }, cwd);
    expect(model).toBe("p/m2");
    expect(applied).toEqual(["p/m2"]);
  });

  test("modelo removido da config é ignorado", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-tui-boot-stale-"));
    saveTuiConfig(cwd, { lastModel: "p/ghost" });
    const model = applySavedModel({ setModel: () => { throw new Error("modelo desconhecido"); } }, cwd);
    expect(model).toBeUndefined();
  });

  test("sem configuração não troca o modelo", () => {
    let calls = 0;
    const model = applySavedModel({ setModel: () => { calls++; return "p/m1"; } }, mkdtempSync(join(tmpdir(), "astro-tui-boot-empty-")));
    expect(model).toBeUndefined();
    expect(calls).toBe(0);
  });
});
