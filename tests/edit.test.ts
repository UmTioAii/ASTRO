import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "../src/tools/edit";

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

function setupFile(content: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-edit-"));
  writeFileSync(join(cwd, "target.txt"), content);
  return cwd;
}

describe("edit tool (F4-3)", () => {
  test("manifesto correto", () => {
    expect(editTool.manifest.name).toBe("edit");
    expect(editTool.manifest.risk).toBe("high");
    expect(editTool.manifest.permission).toBe("write");
    expect(editTool.manifest.timeoutMs).toBe(30_000);
    expect(editTool.manifest.retryable).toBe(false);
    const params = editTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("diff");
    expect(params.required).toContain("path");
    expect(params.required).toContain("diff");
  });

  test("aplica patch de um hunk", async () => {
    const cwd = setupFile("linha 1\nlinha 2\nlinha 3\n");
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -1,3 +1,3 @@
 linha 1
-linha 2
+linha 2 alterada
 linha 3
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("linha 1\nlinha 2 alterada\nlinha 3\n");
  });

  test("aplica patch de 3 hunks sem corromper arquivo", async () => {
    const original = Array.from({ length: 15 }, (_, i) => `linha ${i + 1}`).join("\n") + "\n";
    const cwd = setupFile(original);
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -2,3 +2,3 @@
 linha 2
-linha 3
+linha 3 editada
 linha 4
@@ -7,3 +7,3 @@
 linha 8
-linha 9
+linha 9 editada
 linha 10
@@ -13,3 +13,3 @@
 linha 14
-linha 15
+linha 15 editada
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(cwd, "target.txt"), "utf8");
    expect(content).toContain("linha 3 editada");
    expect(content).toContain("linha 9 editada");
    expect(content).toContain("linha 15 editada");
    expect(content).toContain("linha 1");
    expect(content).toContain("linha 8");
    // estrutura preservada: 15 linhas
    expect(content.split("\n").filter((l) => l.length > 0)).toHaveLength(15);
  });

  test("cria backup .bak antes de aplicar", async () => {
    const cwd = setupFile("original\n");
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -1,1 +1,1 @@
-original
+alterado
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    expect(result.isError).toBeFalsy();

    // backup existe e tem conteúdo original
    const files = readdirSync(cwd).filter((f) => f.startsWith("target.txt") && f.endsWith(".bak"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const backupContent = readFileSync(join(cwd, files[0]!), "utf8");
    expect(backupContent).toBe("original\n");

    // arquivo principal alterado
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("alterado\n");
  });

  test("hunk não corresponde → rollback, arquivo intacto", async () => {
    const original = "conteudo real\n";
    const cwd = setupFile(original);
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -1,1 +1,1 @@
-conteudo que nao existe
+errado
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("hunk");
    // arquivo intacto
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe(original);
  });

  test("adiciona linhas (hunk de inserção)", async () => {
    const cwd = setupFile("a\nb\nc\n");
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -1,3 +1,4 @@
 a
 b
+nova linha
 c
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("a\nb\nnova linha\nc\n");
  });

  test("remove linhas (hunk de remoção)", async () => {
    const cwd = setupFile("a\nb\nc\n");
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -1,3 +1,2 @@
 a
-b
 c
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("a\nc\n");
  });

  test("arquivo inexistente → erro claro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-edit-"));
    const diff = `--- a/ghost.txt
+++ b/ghost.txt
@@ -1,1 +1,1 @@
-a
+b
`;
    const result = await editTool.execute({ path: "ghost.txt", diff }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("não existe");
  });

  test("diff malformado → erro claro", async () => {
    const cwd = setupFile("a\n");
    const result = await editTool.execute({ path: "target.txt", diff: "isto não é um diff" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("diff");
  });

  test("caminho fora do cwd → erro (I-11)", async () => {
    const cwd = setupFile("a\n");
    const diff = `--- a/x.txt
+++ b/x.txt
@@ -1,1 +1,1 @@
-a
+b
`;
    const result = await editTool.execute({ path: "../target.txt", diff }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });

  test("hunk com offset aplicável (contexto deslocado) funciona", async () => {
    const cwd = setupFile("x\nx\nx\nalvo\nx\n");
    // hunk declara @@ -1,1 +1,1 @@ mas o contexto "alvo" está na linha 4
    const diff = `--- a/target.txt
+++ b/target.txt
@@ -1,1 +1,1 @@
-alvo
+alvo modificado
`;
    const result = await editTool.execute({ path: "target.txt", diff }, ctx(cwd));
    // Busca a linha removida em qualquer posição (fuzzy match)
    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(cwd, "target.txt"), "utf8");
    expect(content).toContain("alvo modificado");
    expect(content).not.toContain("alvo\n");
  });
});