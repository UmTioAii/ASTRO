import { readFileSync } from "node:fs";
import { estimateTokens } from "../tokens";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

const PAGE_LINES = 350;
const OVERLAP_LINES = 10;
const MIN_STEP = 50;

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface ReadInput {
  path: string;
  offset?: number;
}

function readInput(input: unknown): ReadInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { path }");
  }
  const raw = input as { path?: unknown; offset?: unknown };
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolError("entrada inválida: \"path\" deve ser uma string não vazia");
  }
  if (
    raw.offset !== undefined &&
    (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 1)
  ) {
    throw new ToolError('"offset" deve ser um inteiro >= 1 (linha inicial, 1-based)');
  }
  return { path: raw.path, ...(raw.offset === undefined ? {} : { offset: raw.offset }) };
}

/** Linhas do arquivo, sem o elemento vazio produzido pela quebra final. */
function fileLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Página de leitura (CMP-11): 350 linhas, overlap 10, cabeçalho com o próximo
 * offset. Acima do cap da saída, encolhe em passos de 50 linhas (até 50).
 */
function page(lines: string[], offset: number | undefined, capTokens: number | undefined): string {
  const total = lines.length;
  const start = offset ?? 1;
  if (total === 0) return "linhas 1-0 de 0";
  if (start > total) return `fim do arquivo (${total} linhas)`;

  let size = PAGE_LINES;
  for (;;) {
    const end = Math.min(start + size - 1, total);
    const next = end < total ? Math.max(start + 1, end - (OVERLAP_LINES - 1)) : undefined;
    const header = next === undefined
      ? `linhas ${start}-${end} de ${total}`
      : `linhas ${start}-${end} de ${total}; para continuar, offset ${next}`;
    const text = [header, ...lines.slice(start - 1, end)].join("\n");
    if (capTokens === undefined || estimateTokens(text) <= capTokens || size <= MIN_STEP) return text;
    size = Math.max(MIN_STEP, size - MIN_STEP);
  }
}

/** Lê um arquivo de texto confinado ao diretório de trabalho, com paginação. */
export const readFileTool: Tool = {
  manifest: {
    name: "read_file",
    description: "Lê um arquivo de texto do diretório de trabalho, em páginas de até 350 linhas.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "Linha inicial (1-based) para continuar a leitura; default 1.",
        },
      },
      required: ["path"],
    },
    risk: "low",
    permission: "read",
    timeoutMs: 5_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { path, offset } = readInput(input);
      const resolved = resolveWithin(ctx.cwd, path);
      const lines = fileLines(readFileSync(resolved, "utf8"));
      return { output: page(lines, offset, ctx.outputLimitTokens) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao ler arquivo: ${message}`);
    }
  },
};
