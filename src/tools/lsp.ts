import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

/**
 * Tool `lsp` — análise de código TypeScript (definition, references, hover) via
 * API do TypeScript 7 (`typescript/unstable/async`), que conversa com o
 * compilador tsgo. A API async usa streams (compatível com Bun no Linux; a sync
 * dependia de `stdout._handle.fd`, que o Bun não expõe em POSIX). O servidor é
 * cacheado por diretório de trabalho e recriado quando os arquivos mudam
 * (assinatura de path+mtime).
 */

const SKIP_DIRS = new Set(["node_modules", ".git", ".astro", "dist", "coverage", ".worktrees"]);

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

type LspCommand = "definition" | "references" | "hover";

interface LspInput {
  command: LspCommand;
  file: string;
  line: number;
  column: number;
}

function parseInput(input: unknown): LspInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado { command, file, line, column }");
  }
  const raw = input as { command?: unknown; file?: unknown; line?: unknown; column?: unknown };
  const command = raw.command;
  if (command !== "definition" && command !== "references" && command !== "hover") {
    throw new ToolError(
      `"command" inválido: ${JSON.stringify(command)} (esperado "definition", "references" ou "hover")`,
    );
  }
  if (typeof raw.file !== "string" || raw.file.length === 0) {
    throw new ToolError('"file" deve ser uma string não vazia');
  }
  if (typeof raw.line !== "number" || !Number.isInteger(raw.line) || raw.line < 1) {
    throw new ToolError('"line" deve ser um inteiro >= 1');
  }
  if (typeof raw.column !== "number" || !Number.isInteger(raw.column) || raw.column < 1) {
    throw new ToolError('"column" deve ser um inteiro >= 1');
  }
  return { command, file: raw.file, line: raw.line, column: raw.column };
}

// --- Tipos estruturais mínimos da API do tsgo (typescript/unstable/async) ---

interface AstNode {
  kind: number;
  pos: number;
  end: number;
}

interface AstSourceFile extends AstNode {
  getLineStarts(): readonly number[];
  getLineAndCharacterOfPosition(position: number): { line: number; character: number };
}

interface NodeHandle {
  readonly path: string;
  resolve(project: unknown): Promise<AstNode | undefined>;
}

interface TsgoSymbol {
  readonly name: string;
  getDocumentationComment(checker: unknown): Promise<string>;
}

interface TsgoChecker {
  getSymbolAtPosition(file: string, position: number): Promise<TsgoSymbol | undefined>;
  getReferencedSymbolsForNode(node: AstNode, position: number): Promise<{
    definition: NodeHandle;
    references: readonly NodeHandle[];
  }[]>;
  getTypeOfSymbol(symbol: TsgoSymbol): Promise<unknown>;
  getSignaturesOfType(type: unknown, kind: number): Promise<readonly unknown[]>;
  typeToString(type: unknown): Promise<string>;
}

interface TsgoProgram {
  getSourceFile(file: string): Promise<AstSourceFile | undefined>;
}

interface TsgoProject {
  program: TsgoProgram;
  checker: TsgoChecker;
}

interface TsgoSnapshot {
  getDefaultProjectForFile(file: string): Promise<TsgoProject | undefined>;
}

interface TsgoApi {
  updateSnapshot(params?: { openFiles?: string[] }): Promise<TsgoSnapshot>;
  close(): Promise<void>;
}

interface AsyncModule {
  API: new (options: { cwd: string }) => TsgoApi;
  SignatureKind: { Call: number };
}

interface AstModule {
  getTokenAtPosition(sourceFile: AstSourceFile, position: number): AstNode;
}

// --- Cache de sessão (um servidor tsgo por cwd, recriado quando arquivos mudam) ---

interface LspSession {
  api: TsgoApi;
  snapshot: TsgoSnapshot;
  signature: string;
  /** Mapeia path em lowercase → path com case original (tsgo lowercases no Windows). */
  fileByLower: Map<string, string>;
}

const sessions = new Map<string, LspSession>();
let asyncMod: AsyncModule | null = null;
let astMod: AstModule | null = null;

async function loadModules(): Promise<{ api: AsyncModule; ast: AstModule }> {
  if (asyncMod === null || astMod === null) {
    const [api, ast] = await Promise.all([
      import("typescript/unstable/async") as Promise<unknown>,
      import("typescript/unstable/ast") as Promise<unknown>,
    ]);
    asyncMod = api as AsyncModule;
    astMod = ast as AstModule;
  }
  return { api: asyncMod, ast: astMod };
}

/** Lista todos os arquivos .ts/.tsx sob `root` (sem seguir symlinks). */
function listTsFiles(root: string): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(absPath);
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(absPath);
      }
    }
  }
  return files.sort();
}

/** Assinatura do workspace: arquivos + mtime, para invalidar o servidor. */
function workspaceSignature(files: readonly string[]): string {
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(`${file}:${statSync(file).mtimeMs}`);
    } catch {
      parts.push(file);
    }
  }
  return parts.join("|");
}

async function getSession(cwd: string): Promise<LspSession> {
  const files = listTsFiles(cwd);
  const signature = workspaceSignature(files);

  const cached = sessions.get(cwd);
  if (cached !== undefined && cached.signature === signature) {
    return cached;
  }
  if (cached !== undefined) {
    await cached.api.close().catch(() => {});
    sessions.delete(cwd);
  }

  const { api: apiModule } = await loadModules();
  const api = new apiModule.API({ cwd });
  const snapshot = await api.updateSnapshot({ openFiles: files });
  const fileByLower = new Map<string, string>(files.map((f) => [f.toLowerCase(), f]));
  const session: LspSession = { api, snapshot, signature, fileByLower };
  sessions.set(cwd, session);
  return session;
}

/** Fecha todos os servidores tsgo abertos (limpeza explícita em testes). */
export async function closeLspSessions(): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const session of sessions.values()) {
    closing.push(session.api.close().catch(() => {})); // sessão já morta: ignora
  }
  sessions.clear();
  await Promise.allSettled(closing);
}

// --- Conversão de posições ---

interface Location {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

async function handleToLocation(
  session: LspSession,
  project: TsgoProject,
  handle: NodeHandle,
): Promise<Location | null> {
  const rawPath = resolve(handle.path);
  const absPath = session.fileByLower.get(rawPath.toLowerCase()) ?? rawPath;
  const node = await handle.resolve(project);
  if (node === undefined) return null;
  const sourceFile = await project.program.getSourceFile(absPath);
  if (sourceFile === undefined) return null;
  const start = sourceFile.getLineAndCharacterOfPosition(node.pos);
  const end = sourceFile.getLineAndCharacterOfPosition(node.end);
  return {
    file: absPath,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function dedupeLocations(locations: readonly Location[]): Location[] {
  const seen = new Set<string>();
  const result: Location[] = [];
  for (const loc of locations) {
    const key = `${loc.file}:${loc.startLine}:${loc.startColumn}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(loc);
    }
  }
  return result;
}

// --- Tool ---

/** Análise de código TypeScript (definition, references, hover) confinada ao cwd. */
export const lspTool: Tool = {
  manifest: {
    name: "lsp",
    description:
      "Análise de código TypeScript: definition (vá para a definição), references (encontre " +
      "referências) e hover (informações de tipo). Posições são 1-based.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Sub-comando: 'definition', 'references' ou 'hover'.",
        },
        file: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho.",
        },
        line: {
          type: "number",
          description: "Linha (1-based).",
        },
        column: {
          type: "number",
          description: "Coluna (1-based).",
        },
      },
      required: ["command", "file", "line", "column"],
    },
    risk: "low",
    permission: "read",
    timeoutMs: 15_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const parsed = parseInput(input);
      const absPath = resolveWithin(ctx.cwd, parsed.file);

      let stats;
      try {
        stats = statSync(absPath);
      } catch {
        return failure(`arquivo não existe: ${parsed.file}`);
      }
      if (!stats.isFile()) {
        return failure(`caminho não é um arquivo: ${parsed.file}`);
      }

      const session = await getSession(ctx.cwd);
      const project = await session.snapshot.getDefaultProjectForFile(absPath);
      if (project === undefined) {
        return failure(`arquivo fora do programa TypeScript: ${parsed.file}`);
      }
      const sourceFile = await project.program.getSourceFile(absPath);
      if (sourceFile === undefined) {
        return failure(`arquivo fora do programa TypeScript: ${parsed.file}`);
      }

      const lineStarts = sourceFile.getLineStarts();
      const lineIndex = parsed.line - 1;
      if (lineIndex >= lineStarts.length) {
        return failure(`linha ${parsed.line} além do fim do arquivo (${lineStarts.length} linhas)`);
      }
      const position = lineStarts[lineIndex]! + (parsed.column - 1);

      if (parsed.command === "hover") {
        const symbol = await project.checker.getSymbolAtPosition(absPath, position);
        if (symbol === undefined) {
          return { output: "" };
        }
        const type = await project.checker.getTypeOfSymbol(symbol);
        const typeText = type === undefined ? "" : await project.checker.typeToString(type);
        const { api } = await loadModules();
        const isCallable =
          type !== undefined && (await project.checker.getSignaturesOfType(type, api.SignatureKind.Call)).length > 0;
        const prefix = isCallable ? "function " : "";
        const docs = await symbol.getDocumentationComment(project.checker);
        const hover = docs.length > 0 ? `${prefix}${symbol.name}: ${typeText}\n\n${docs}` : `${prefix}${symbol.name}: ${typeText}`;
        return { output: hover };
      }

      // definition e references usam o token na posição + busca de símbolos
      const { ast } = await loadModules();
      const token = ast.getTokenAtPosition(sourceFile, position);
      const entries = await project.checker.getReferencedSymbolsForNode(token, position);

      if (parsed.command === "definition") {
        const resolved = await Promise.all(
          entries.map((entry) => handleToLocation(session, project, entry.definition)),
        );
        const locations = resolved.filter((loc): loc is Location => loc !== null);
        return { output: JSON.stringify(dedupeLocations(locations)) };
      }

      // references: definições + todas as referências, deduplicadas
      const pending: Promise<Location | null>[] = [];
      for (const entry of entries) {
        pending.push(handleToLocation(session, project, entry.definition));
        for (const ref of entry.references) pending.push(handleToLocation(session, project, ref));
      }
      const resolved = await Promise.all(pending);
      const locations = resolved.filter((loc): loc is Location => loc !== null);
      return { output: JSON.stringify(dedupeLocations(locations)) };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no lsp: ${message}`);
    }
  },
};