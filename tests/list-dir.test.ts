import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirTool } from "../src/tools/list-dir";

interface DirNode {
  name: string;
  type: "file" | "dir";
  children?: DirNode[];
}

function setupNested(levels: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-"));
  let current = cwd;
  for (let i = 0; i < levels; i++) {
    const dirName = `level${i}`;
    const fileName = `file${i}.txt`;
    writeFileSync(join(current, fileName), `content ${i}`);
    mkdirSync(join(current, dirName));
    current = join(current, dirName);
  }
  writeFileSync(join(current, "leaf.txt"), "leaf");
  return cwd;
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

describe("list_dir tool (F4-2)", () => {
  test("manifesto correto", () => {
    expect(listDirTool.manifest.name).toBe("list_dir");
    expect(listDirTool.manifest.risk).toBe("low");
    expect(listDirTool.manifest.permission).toBe("read");
    expect(listDirTool.manifest.timeoutMs).toBe(10_000);
    expect(listDirTool.manifest.retryable).toBe(true);
    const params = listDirTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("depth");
    expect(params.required).toHaveLength(0);
  });

  test("lista árvore com arquivos e diretórios", async () => {
    const cwd = setupNested(2);
    const result = await listDirTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    expect(tree.type).toBe("dir");
    expect(tree.children).toBeDefined();
    const names = tree.children!.map((c) => c.name);
    expect(names).toContain("file0.txt");
    expect(names).toContain("level0");
    const level0 = tree.children!.find((c) => c.name === "level0")!;
    expect(level0.type).toBe("dir");
    expect(level0.children).toBeDefined();
  });

  test("default depth 3: para no nível 3", async () => {
    const cwd = setupNested(6);
    const result = await listDirTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;

    // Percorre até profundidade 3; level2 (3º nível) não deve ter children
    const level0 = tree.children!.find((c) => c.name === "level0")!;
    const level1 = level0.children!.find((c) => c.name === "level1")!;
    const level2 = level1.children!.find((c) => c.name === "level2")!;
    // depth 3 significa que desce 3 níveis: raiz(0) → level0(1) → level1(2) → level2(3, sem children)
    expect(level2.children).toBeUndefined();
  });

  test("depth customizado respeita maxDepth=1", async () => {
    const cwd = setupNested(3);
    const result = await listDirTool.execute({ depth: 1 }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    const level0 = tree.children!.find((c) => c.name === "level0")!;
    // depth 1: só o primeiro nível de children, sem children de children
    expect(level0.children).toBeUndefined();
  });

  test("depth máximo 10: valores acima clampam", async () => {
    const cwd = setupNested(3);
    const result = await listDirTool.execute({ depth: 50 }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    let depth = 0;
    let node: DirNode | undefined = tree;
    while (node?.children !== undefined) {
      depth++;
      node = node.children[0];
    }
    expect(depth).toBeLessThanOrEqual(10);
  });

  test("lista 5 níveis sem estouro de stack", async () => {
    const cwd = setupNested(5);
    const result = await listDirTool.execute({ depth: 5 }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    // Percorre 5 níveis
    let node: DirNode | undefined = tree.children!.find((c) => c.name === "level0");
    for (let i = 1; i < 5; i++) {
      expect(node).toBeDefined();
      node = node!.children?.find((c) => c.name === `level${i}`);
    }
    expect(node).toBeDefined();
  });

  test("path relativo restringe busca", async () => {
    const cwd = setupNested(2);
    const result = await listDirTool.execute({ path: "level0" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    expect(tree.name).toBe("level0");
    expect(tree.children!.map((c) => c.name)).toContain("file1.txt");
    expect(tree.children!.map((c) => c.name)).not.toContain("file0.txt");
  });

  test("caminho fora do cwd → erro (I-11)", async () => {
    const cwd = setupNested(1);
    const result = await listDirTool.execute({ path: "../" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });

  test("path inexistente → erro claro", async () => {
    const cwd = setupNested(1);
    const result = await listDirTool.execute({ path: "ghost" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("não existe");
  });
});