import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

type DiffLineType = "context" | "remove" | "add";

interface DiffLine {
  type: DiffLineType;
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface EditInput {
  path: string;
  diff: string;
}

function parseInput(input: unknown): EditInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { path, diff }");
  }
  const raw = input as { path?: unknown; diff?: unknown };
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolError('"path" deve ser uma string não vazia');
  }
  if (typeof raw.diff !== "string" || raw.diff.length === 0) {
    throw new ToolError('"diff" deve ser uma string não vazia');
  }
  return { path: raw.path, diff: raw.diff };
}

/** Extrai o start e count de "@@ -start[,count] +start[,count] @@". */
function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) {
    throw new ToolError(`cabeçalho de hunk inválido: "${line}"`);
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** Faz o parse do unified diff em hunks; ignora linhas ---/+++ e metadata. */
function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  const rawLines = diff.split(/\r?\n/);
  // A última linha vazia é artefato do \n final do diff, não um context vazio
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      if (current !== null) hunks.push(current);
      const header = parseHunkHeader(line);
      current = { ...header, lines: [] };
      continue;
    }
    if (current === null) continue; // linhas ---/+++ e contexto antes do primeiro hunk

    if (line.startsWith("+")) {
      current.lines.push({ type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "remove", text: line.slice(1) });
    } else if (line.startsWith(" ") || line.length === 0) {
      current.lines.push({ type: "context", text: line.startsWith(" ") ? line.slice(1) : "" });
    }
    // linhas de metadata (\ No newline at end of file) são ignoradas
  }
  if (current !== null) hunks.push(current);

  if (hunks.length === 0) {
    throw new ToolError("diff malformado: nenhum hunk encontrado (esperado '@@ ... @@')");
  }
  return hunks;
}

/** Verifica se o hunk aplica em `lines` na posição `pos` (0-based). */
function hunkMatchesAt(lines: string[], pos: number, hunk: Hunk): boolean {
  let cursor = pos;
  for (const dl of hunk.lines) {
    if (dl.type === "context" || dl.type === "remove") {
      if (cursor >= lines.length) return false;
      const actual = lines[cursor] ?? "";
      if (actual !== dl.text) return false;
      cursor++;
    }
    // add: não consome linha do arquivo original
  }
  return true;
}

/** Encontra a posição (0-based) onde o hunk aplica, com busca fuzzy. Devolve -1 se não aplica. */
function findHunkPosition(lines: string[], hunk: Hunk): number {
  const declared = hunk.oldStart - 1;
  if (declared >= 0 && declared <= lines.length && hunkMatchesAt(lines, declared, hunk)) {
    return declared;
  }
  // fuzzy: procura a primeira remove/context line em qualquer posição
  const firstRemove = hunk.lines.find((l) => l.type === "remove" || l.type === "context");
  if (firstRemove === undefined) {
    // hunk só de inserção: aplica na posição declarada
    return Math.min(Math.max(declared, 0), lines.length);
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === firstRemove.text && hunkMatchesAt(lines, i, hunk)) {
      return i;
    }
  }
  return -1;
}

/** Aplica todos os hunks a uma cópia das linhas; lança ToolError em falha. */
function applyHunks(lines: string[], hunks: Hunk[]): string[] {
  const result = [...lines];
  // Aplica do último hunk para o primeiro para não invalidar posições seguintes
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const pos = findHunkPosition(result, hunk);
    if (pos === -1) {
      const first = hunk.lines.find((l) => l.type === "remove" || l.type === "context");
      throw new ToolError(
        `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ` +
          `não corresponde ao arquivo (contexto esperado: "${first?.text ?? ""}")`,
      );
    }

    // Substitui o bloco antigo pelo novo
    const oldBlock: string[] = [];
    const newBlock: string[] = [];
    for (const dl of hunk.lines) {
      if (dl.type === "context") {
        oldBlock.push(dl.text);
        newBlock.push(dl.text);
      } else if (dl.type === "remove") {
        oldBlock.push(dl.text);
      } else {
        newBlock.push(dl.text);
      }
    }
    result.splice(pos, oldBlock.length, ...newBlock);
  }

  return result;
}

/** Edição cirúrgica via unified diff, com backup automático e rollback. */
export const editTool: Tool = {
  manifest: {
    name: "edit",
    description:
      "Aplica um patch unified diff a um arquivo existente. Cria backup .bak antes de aplicar; " +
      "faz rollback se algum hunk não corresponder.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho.",
        },
        diff: {
          type: "string",
          description: "Unified diff (formato git diff) com os hunks a aplicar.",
        },
      },
      required: ["path", "diff"],
    },
    risk: "high",
    permission: "write",
    timeoutMs: 30_000,
    retryable: false,
  },

  async execute(input, ctx): Promise<ToolResult> {
    let path: string;
    try {
      const parsed = parseInput(input);
      path = parsed.path;
      const absPath = resolveWithin(ctx.cwd, parsed.path);

      if (!existsSync(absPath)) {
        return failure(`arquivo não existe: ${parsed.path}`);
      }

      const original = readFileSync(absPath, "utf8");
      const hunks = parseDiff(parsed.diff);

      // Aplica em memória; falha aqui não toca o arquivo
      const lines = original.split(/\r?\n/);
      // diff de arquivo terminando com \n produz split com última linha vazia; normalizamos
      const hadTrailingNewline = original.endsWith("\n");
      const working = hadTrailingNewline ? lines.slice(0, -1) : lines;

      const applied = applyHunks(working, hunks);
      const newContent = applied.join("\n") + (hadTrailingNewline ? "\n" : "");

      if (newContent === original) {
        return { output: "nenhuma mudança aplicada (diff produz conteúdo idêntico)" };
      }

      // Backup timestampado antes de escrever
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${absPath}.${timestamp}.bak`;
      copyFileSync(absPath, backupPath);

      // Escreve o novo conteúdo (apenas se todos os hunks aplicaram)
      writeFileSync(absPath, newContent, "utf8");

      return {
        output: JSON.stringify({
          path: parsed.path,
          hunksApplied: hunks.length,
          backup: backupPath,
        }),
      };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao aplicar patch: ${message}`);
    }
  },
};