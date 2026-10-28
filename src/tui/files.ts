/** Índice de arquivos do cwd e busca fuzzy para o `@` da TUI (sem dependências). */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".astro", "dist", "build", "coverage", ".worktrees", ".venv"]);

export interface FileIndexOptions {
  maxFiles?: number;
  maxDepth?: number;
  maxDirs?: number;
}

/** Lista arquivos relativos (POSIX) até um teto; ignora diretórios de build e estado. */
export function indexFiles(cwd: string, options: FileIndexOptions = {}): string[] {
  const limit = options.maxFiles ?? 2000;
  const maxDepth = options.maxDepth ?? 6;
  const maxDirs = options.maxDirs ?? 500;
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: "", depth: 0 }];
  let head = 0;
  let visited = 0;
  while (head < queue.length && files.length < limit && visited < maxDirs) {
    const current = queue[head++]!;
    visited++;
    let entries;
    try {
      entries = readdirSync(current.dir === "" ? cwd : join(cwd, current.dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      const rel = current.dir === "" ? entry.name : `${current.dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (current.depth < maxDepth) queue.push({ dir: rel, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  }
  return files;
}

/** Subsequência case-insensitive; score menor é melhor (lacunas pesam). */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  if (query === "") return candidate.length;
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  let index = 0;
  let score = 0;
  let last = -1;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found < 0) return undefined;
    score += found - last;
    last = found;
    index = found + 1;
  }
  return score;
}

/** Melhores correspondências, com prefixo direto na frente. */
export function searchFiles(files: readonly string[], query: string, limit = 6): string[] {
  const exact = files.filter((file) => file.toLowerCase().startsWith(query.toLowerCase()));
  const rest = files
    .filter((file) => !exact.includes(file))
    .map((file) => ({ file, score: fuzzyScore(query, file) }))
    .filter((item): item is { file: string; score: number } => item.score !== undefined)
    .sort((a, b) => a.score - b.score || a.file.localeCompare(b.file))
    .map((item) => item.file);
  return [...exact, ...rest].slice(0, limit);
}
