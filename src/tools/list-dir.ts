import { readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 10;

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface ListDirInput {
  path: string;
  depth: number;
}

interface DirNode {
  name: string;
  type: "file" | "dir";
  children?: DirNode[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".astro", "dist", "coverage", ".worktrees"]);

function parseInput(input: unknown): ListDirInput {
  const raw = (typeof input === "object" && input !== null ? input : {}) as {
    path?: unknown;
    depth?: unknown;
  };
  const path = typeof raw.path === "string" && raw.path.length > 0 ? raw.path : ".";
  let depth = typeof raw.depth === "number" && Number.isFinite(raw.depth) ? raw.depth : DEFAULT_DEPTH;
  if (depth < 1) depth = 1;
  if (depth > MAX_DEPTH) depth = MAX_DEPTH;
  return { path, depth };
}

/** Constrói a árvore de diretórios a partir de `dir`, até `depth` níveis. */
function buildTree(dir: string, depth: number): DirNode {
  const children: DirNode[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { name: basename(dir), type: "dir" };
  }

  for (const entry of entries) {
    // Não segue symlink nem diretórios ignorados
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (depth > 1) {
        children.push(buildTree(`${dir}/${entry.name}`, depth - 1));
      } else {
        children.push({ name: entry.name, type: "dir" });
      }
    } else if (entry.isFile()) {
      children.push({ name: entry.name, type: "file" });
    }
    // symlinks e outros tipos são omitidos
  }

  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { name: basename(dir), type: "dir", children };
}

/** Lista a árvore de diretórios com profundidade configurável, confinada ao cwd. */
export const listDirTool: Tool = {
  manifest: {
    name: "list_dir",
    description: "Lista a árvore de diretórios a partir de um caminho, com profundidade configurável.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho relativo ao cwd (default: \".\").",
        },
        depth: {
          type: "number",
          description: "Profundidade máxima da árvore (default: 3, máximo: 10).",
        },
      },
      required: [],
    },
    risk: "low",
    permission: "read",
    timeoutMs: 10_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { path, depth } = parseInput(input);
      const root = resolveWithin(ctx.cwd, path);

      // Caminho precisa existir e ser diretório
      let stats;
      try {
        stats = statSync(root);
      } catch {
        return failure(`caminho não existe: ${path}`);
      }
      if (!stats.isDirectory()) {
        return failure(`caminho não é um diretório: ${path}`);
      }

      const tree = buildTree(root, depth);
      return { output: JSON.stringify(tree) };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao listar diretório: ${message}`);
    }
  },
};