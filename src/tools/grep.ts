import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

const MAX_RESULTS = 100;
const SKIP_DIRS = new Set(["node_modules", ".git", ".astro", "dist", "coverage", ".worktrees"]);

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface GrepInput {
  pattern: string;
  path: string;
  flags: string;
}

interface GrepMatch {
  file: string;
  line: number;
  match: string;
}

function parseInput(input: unknown): GrepInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { pattern }");
  }
  const raw = input as { pattern?: unknown; path?: unknown; flags?: unknown };
  if (typeof raw.pattern !== "string" || raw.pattern.length === 0) {
    throw new ToolError('"pattern" deve ser uma string não vazia');
  }
  return {
    pattern: raw.pattern,
    path: typeof raw.path === "string" ? raw.path : ".",
    flags: typeof raw.flags === "string" ? raw.flags : "-i",
  };
}

function compileRegex(pattern: string, flags: string): RegExp {
  const reFlags = flags.includes("i") ? "i" : "";
  try {
    return new RegExp(pattern, reFlags);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ToolError(`regex inválida: ${detail}`);
  }
}

/** Percorre diretórios dentro de `root`, ignorando SKIP_DIRS; callback devolve false para parar. */
function walk(root: string, visit: (absPath: string) => boolean): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // diretório ilegível: pula
    }
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(absPath);
      } else if (entry.isFile()) {
        if (!visit(absPath)) return;
      }
    }
  }
}

/** Busca por regex em arquivos do workspace, confinada ao cwd. */
export const grepTool: Tool = {
  manifest: {
    name: "grep",
    description: "Busca por regex nos arquivos do diretório de trabalho. Retorna {file, line, match}.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex a buscar (formato JavaScript RegExp).",
        },
        path: {
          type: "string",
          description: "Subdiretório relativo ao cwd onde buscar (default: \".\").",
        },
        flags: {
          type: "string",
          description: "Flags da regex (default: \"-i\" para case-insensitive).",
        },
      },
      required: ["pattern"],
    },
    risk: "low",
    permission: "read",
    timeoutMs: 30_000,
    retryable: true,
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { pattern, path, flags } = parseInput(input);
      const regex = compileRegex(pattern, flags);
      const root = resolveWithin(ctx.cwd, path);

      const matches: GrepMatch[] = [];
      let stopped = false;

      walk(root, (absPath) => {
        if (stopped) return false;
        let content: string;
        try {
          content = readFileSync(absPath, "utf8");
        } catch {
          return true; // arquivo ilegível: pula
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({
              file: absPath,
              line: i + 1,
              match: lines[i]!,
            });
            if (matches.length >= MAX_RESULTS) {
              stopped = true;
              return false;
            }
          }
        }
        return true;
      });

      return { output: JSON.stringify(matches) };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no grep: ${message}`);
    }
  },
};