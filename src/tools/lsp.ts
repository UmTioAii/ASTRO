import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

/**
 * Tool `lsp` — análise de código TypeScript (definition, references, hover) via
 * API nativa do TypeScript 7 (`typescript/unstable/sync`), que conversa com o
 * compilador tsgo. O servidor é cacheado por diretório de trabalho e recriado
 * quando os arquivos mudam (assinatura de path+mtime).
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

// --- Tipos estruturais mínimos da API do tsgo (typescript/unstable/sync) ---

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
  resolve(project: unknown): AstNode | undefined;
}

interface TsgoSymbol {
  readonly name: string;
  getDocumentationComment(checker: unknown): string;
}

interface TsgoChecker {
  getSymbolAtPosition(file: string, position: number): TsgoSymbol | undefined;
  getReferencedSymbolsForNode(node: AstNode, position: number): {
    definition: NodeHandle;
    references: readonly NodeHandle[];
  }[];
  getTypeOfSymbol(symbol: TsgoSymbol): unknown;
  getSignaturesOfType(type: unknown, kind: number): readonly unknown[];
  typeToString(type: unknown): string;
}

interface TsgoProgram {
  getSourceFile(file: string): AstSourceFile | undefined;
}

interface TsgoProject {
  program: TsgoProgram;
  checker: TsgoChecker;
}

interface TsgoSnapshot {
  getDefaultProjectForFile(file: string): TsgoProject | undefined;
}

interface TsgoApi {
  updateSnapshot(params?: { openFiles?: string[] }): TsgoSnapshot;
  close(): void;
}

interface SyncModule {
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
let syncMod: SyncModule | null = null;
let astMod: AstModule | null = null;

async function loadModules(): Promise<{ sync: SyncModule; ast: AstModule }> {
  if (syncMod === null || astMod === null) {
    const [sync, ast] = await Promise.all([
      import("typescript/unstable/sync") as Promise<unknown>,
      import("typescript/unstable/ast") as Promise<unknown>,
    ]);
    syncMod = sync as SyncModule;
    astMod = ast as AstModule;
  }
  return { sync: syncMod, ast: astMod };
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
    cached.api.close();
    sessions.delete(cwd);
  }

  const { sync } = await loadModules();
  const api = new sync.API({ cwd });
  const snapshot = api.updateSnapshot({ openFiles: files });
  const fileByLower = new Map<string, string>(files.map((f) => [f.toLowerCase(), f]));
  const session: LspSession = { api, snapshot, signature, fileByLower };
  sessions.set(cwd, session);
  return session;
}

/** Fecha todos os servidores tsgo abertos (limpeza explícita em testes). */
export function closeLspSessions(): void {
  for (const session of sessions.values()) {
    try {
      session.api.close();
    } catch {
      // sessão já morta: ignora
    }
  }
  sessions.clear();
}

// --- Conversão de posições ---

interface Location {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

function handleToLocation(session: LspSession, project: TsgoProject, handle: NodeHandle): Location | null {
  const rawPath = resolve(handle.path);
  const absPath = session.fileByLower.get(rawPath.toLowerCase()) ?? rawPath;
  const node = handle.resolve(project);
  if (node === undefined) return null;
  const sourceFile = project.program.getSourceFile(absPath);
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
      const project = session.snapshot.getDefaultProjectForFile(absPath);
      if (project === undefined) {
        return failure(`arquivo fora do programa TypeScript: ${parsed.file}`);
      }
      const sourceFile = project.program.getSourceFile(absPath);
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
        const symbol = project.checker.getSymbolAtPosition(absPath, position);
        if (symbol === undefined) {
          return { output: "" };
        }
        const type = project.checker.getTypeOfSymbol(symbol);
        const typeText = type === undefined ? "" : project.checker.typeToString(type);
        const { sync } = await loadModules();
        const isCallable =
          type !== undefined && project.checker.getSignaturesOfType(type, sync.SignatureKind.Call).length > 0;
        const prefix = isCallable ? "function " : "";
        const docs = symbol.getDocumentationComment(project.checker);
        const hover = docs.length > 0 ? `${prefix}${symbol.name}: ${typeText}\n\n${docs}` : `${prefix}${symbol.name}: ${typeText}`;
        return { output: hover };
      }

      // definition e references usam o token na posição + busca de símbolos
      const { ast } = await loadModules();
      const token = ast.getTokenAtPosition(sourceFile, position);
      const entries = project.checker.getReferencedSymbolsForNode(token, position);

      if (parsed.command === "definition") {
        const locations = entries
          .map((entry) => handleToLocation(session, project, entry.definition))
          .filter((loc): loc is Location => loc !== null);
        return { output: JSON.stringify(dedupeLocations(locations)) };
      }

      // references: definições + todas as referências, deduplicadas
      const locations: Location[] = [];
      for (const entry of entries) {
        const def = handleToLocation(session, project, entry.definition);
        if (def !== null) locations.push(def);
        for (const ref of entry.references) {
          const loc = handleToLocation(session, project, ref);
          if (loc !== null) locations.push(loc);
        }
      }
      return { output: JSON.stringify(dedupeLocations(locations)) };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no lsp: ${message}`);
    }
  },
};