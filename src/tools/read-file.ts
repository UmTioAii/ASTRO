import { readFileSync } from "node:fs";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

function readPath(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { path }");
  }
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolError("entrada inválida: \"path\" deve ser uma string não vazia");
  }
  return path;
}

/** Lê um arquivo de texto confinado ao diretório de trabalho. */
export const readFileTool: Tool = {
  manifest: {
    name: "read_file",
    description: "Lê um arquivo de texto do diretório de trabalho.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho.",
        },
      },
      required: ["path"],
    },
    risk: "low",
    permission: "read",
    timeoutMs: 5_000,
    retryable: true,
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const path = resolveWithin(ctx.cwd, readPath(input));
      return { output: readFileSync(path, "utf8") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao ler arquivo: ${message}`);
    }
  },
};
