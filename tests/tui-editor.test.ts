import { describe, expect, test } from "bun:test";
import { COMMANDS, applyCompletion, completionItems } from "../src/tui/editor";

const files = ["src/app.ts", "notas/ideias.md"];

describe("completions do editor (T2, #63)", () => {
  test("/ completa comandos e para no primeiro espaço", () => {
    expect(completionItems("/mo", COMMANDS, files)).toContain("/model");
    expect(completionItems("/ne")).toEqual(["/new"]);
    expect(completionItems("/res")).toEqual(["/resume"]);
    expect(completionItems("/model p/m1", COMMANDS, files)).toEqual([]);
    expect(completionItems("texto", COMMANDS, files)).toEqual([]);
    expect(completionItems("daniel@exemplo.com", COMMANDS, files)).toEqual([]);
  });

  test("@ completa arquivos e preserva o texto anterior", () => {
    expect(completionItems("leia @app", COMMANDS, files)).toEqual(["@src/app.ts"]);
    expect(completionItems("leia @nmd", COMMANDS, files)).toEqual(["@notas/ideias.md"]);
    expect(completionItems("leia @notas/", COMMANDS, files)).toEqual(["@notas/ideias.md"]);
  });

  test("applyCompletion substitui comando e insere arquivo com espaço", () => {
    expect(applyCompletion("/mo", "/model")).toBe("/model");
    expect(applyCompletion("leia @app", "@src/app.ts")).toBe("leia @src/app.ts ");
  });
});
