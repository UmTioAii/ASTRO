import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, indexFiles, searchFiles } from "../src/tui/files";

describe("índice de arquivos (T2, #63)", () => {
  test("lista arquivos relativos e ignora build, estado e ocultos", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-files-"));
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "notas"));
    mkdirSync(join(cwd, "node_modules"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".oculto"));
    writeFileSync(join(cwd, "src", "app.ts"), "x");
    writeFileSync(join(cwd, "notas", "ideias.md"), "x");
    writeFileSync(join(cwd, "README.md"), "x");
    writeFileSync(join(cwd, "node_modules", "dep.js"), "x");
    writeFileSync(join(cwd, ".git", "config"), "x");
    writeFileSync(join(cwd, ".oculto", "segredo"), "x");
    writeFileSync(join(cwd, ".env"), "SEGREDO=1");

    const files = indexFiles(cwd).sort();
    expect(files).toEqual(["README.md", "notas/ideias.md", "src/app.ts"]);
  });

  test("respeita o teto de arquivos", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-files-limit-"));
    for (let i = 0; i < 5; i++) writeFileSync(join(cwd, `f${i}.txt`), "x");
    expect(indexFiles(cwd, { maxFiles: 3 })).toHaveLength(3);
  });

  test("busca fuzzy prefere prefixo e aceita lacunas", () => {
    expect(fuzzyScore("nmd", "notas/ideias.md")).toBeDefined();
    expect(fuzzyScore("zzz", "notas/ideias.md")).toBeUndefined();
    const files = ["src/app.ts", "notas/ideias.md", "notas/notas.md"];
    expect(searchFiles(files, "notas")[0]).toBe("notas/ideias.md");
    expect(searchFiles(files, "app")).toContain("src/app.ts");
    expect(searchFiles(files, "nmd")).toContain("notas/ideias.md");
  });

  test("limita diretórios visitados e ignora arquivos ocultos", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-files-dirs-"));
    for (const name of ["a", "b", "c"]) {
      mkdirSync(join(cwd, name));
      writeFileSync(join(cwd, name, `${name}.txt`), "x");
    }
    writeFileSync(join(cwd, ".env"), "x");
    const files = indexFiles(cwd, { maxDirs: 2 });
    expect(files).not.toContain("c/c.txt");
    expect(files.some((file) => file.startsWith("."))).toBe(false);
  });});
