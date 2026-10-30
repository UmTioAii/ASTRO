import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "../src/tools/read-file";

function workspace(content: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-read-page-"));
  writeFileSync(join(cwd, "file.txt"), content);
  return cwd;
}

const numbered = (count: number, text = (index: number) => `linha ${index}`): string =>
  Array.from({ length: count }, (_, index) => text(index + 1)).join("\n") + "\n";

const ctx = (cwd: string, outputLimitTokens?: number) => ({
  cwd, run: "r1", agent: "coder", ...(outputLimitTokens === undefined ? {} : { outputLimitTokens }),
});

const body = (output: string): string[] => output.split("\n").slice(1);

describe("read_file paginado (S-16, CMP-11)", () => {
  test("primeira página: 350 linhas, sem offset, com próximo offset (overlap 10)", async () => {
    const cwd = workspace(numbered(1000));
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 8000));
    const lines = result.output.split("\n");

    expect(result.isError).toBeFalsy();
    expect(lines[0]).toBe("linhas 1-350 de 1000; para continuar, offset 341");
    expect(lines[1]).toBe("linha 1");
    expect(lines[350]).toBe("linha 350");
    expect(lines).toHaveLength(351);
  });

  test("página intermediária usa o offset pedido e repete 10 linhas no overlap", async () => {
    const cwd = workspace(numbered(1000));
    const result = await readFileTool.execute({ path: "file.txt", offset: 341 }, ctx(cwd, 8000));
    const lines = result.output.split("\n");

    expect(lines[0]).toBe("linhas 341-690 de 1000; para continuar, offset 681");
    expect(lines[1]).toBe("linha 341");
    expect(lines[350]).toBe("linha 690");
    expect(lines[11]).toBe("linha 351");
  });

  test("última página não anuncia continuação", async () => {
    const cwd = workspace(numbered(1000));
    const result = await readFileTool.execute({ path: "file.txt", offset: 691 }, ctx(cwd, 8000));
    const lines = result.output.split("\n");

    expect(lines[0]).toBe("linhas 691-1000 de 1000");
    expect(lines).not.toContain("para continuar");
    expect(lines[1]).toBe("linha 691");
    expect(lines.at(-1)).toBe("linha 1000");
  });

  test("arquivo menor que uma página devolve tudo, sem cabeçalho de continuação", async () => {
    const cwd = workspace(numbered(10));
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 8000));
    expect(result.output).toBe(`linhas 1-10 de 10\n${numbered(10)}`.trimEnd());
  });

  test("arquivo vazio devolve página vazia; CRLF e sem newline final contam linhas corretamente", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-read-edge-"));
    writeFileSync(join(cwd, "empty.txt"), "");
    const empty = await readFileTool.execute({ path: "empty.txt" }, ctx(cwd, 8000));
    expect(empty.output).toBe("linhas 1-0 de 0");

    writeFileSync(join(cwd, "crlf.txt"), "a\r\nb\r\n");
    expect((await readFileTool.execute({ path: "crlf.txt" }, ctx(cwd, 8000))).output)
      .toBe("linhas 1-2 de 2\na\nb");

    writeFileSync(join(cwd, "no-final.txt"), "a\nb");
    expect((await readFileTool.execute({ path: "no-final.txt" }, ctx(cwd, 8000))).output)
      .toBe("linhas 1-2 de 2\na\nb");
  });

  test("offset além do total devolve fim do arquivo sem erro", async () => {
    const cwd = workspace(numbered(10));
    const result = await readFileTool.execute({ path: "file.txt", offset: 11 }, ctx(cwd, 8000));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("fim do arquivo");
    expect(result.output).toContain("10 linhas");
  });

  test("offset inválido falha", async () => {
    const cwd = workspace(numbered(10));
    for (const offset of [0, -1, 1.5]) {
      const result = await readFileTool.execute({ path: "file.txt", offset }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("offset");
    }
  });

  test("página acima do cap encolhe em passos de 50 linhas", async () => {
    const cwd = workspace(numbered(400, (index) => `linha ${index} ${"x".repeat(5000)}`));
    // cap 200 tokens = 800 chars: nem 50 linhas cabem, mas o passo mínimo é 50.
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 200));
    const lines = result.output.split("\n");
    const header = lines[0]!;

    expect(header).toMatch(/^linhas 1-(\d+) de 400/);
    const end = Number(/^linhas 1-(\d+)/.exec(header)![1]);
    expect(end).toBeLessThanOrEqual(50);
    expect(body(result.output).filter((line) => line.startsWith("linha ")).length).toBe(end);
  });
});
