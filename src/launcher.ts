#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Erro de runtime ausente; a mensagem é a instrução para o usuário. */
export class MissingBunError extends Error {
  override name = "MissingBunError";
}

export interface ResolveDeps {
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  execPath?: string;
  runningUnderBun?: boolean;
  resolve?: (id: string) => string;
  exists?: (path: string) => boolean;
  which?: (name: string) => string | undefined;
}

function whichFromPath(name: string, env: Record<string, string | undefined>): string | undefined {
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function missingRuntime(): MissingBunError {
  return new MissingBunError(
    "runtime Bun não encontrado. Reinstale o pacote para baixar as dependências corretamente:\n" +
    "  npm install -g @umtioai/astro-harness@alpha\n" +
    "ou aponte para um Bun existente no seu sistema:\n" +
    "  ASTRO_BUN_PATH=/caminho/para/bun astro --help",
  );
}

/**
 * Ordem de resolução: 
 * 1. ASTRO_BUN_PATH (variável de ambiente)
 * 2. Bun que está executando o script (se rodando via bun run)
 * 3. binário dentro do pacote npm "bun" (nossa nova dependência)
 * 4. bun no PATH global do sistema
 */
export function resolveBun(deps: ResolveDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  
  // 1. Override manual
  const explicit = env.ASTRO_BUN_PATH;
  if (explicit !== undefined && explicit !== "") {
    if (!exists(explicit)) {
      throw new MissingBunError(`ASTRO_BUN_PATH aponta para "${explicit}", que não existe`);
    }
    return explicit;
  }

  // 2. Já estamos rodando dentro do Bun?
  const runningUnderBun = deps.runningUnderBun
    ?? typeof (process.versions as Record<string, string | undefined>).bun === "string";
  if (runningUnderBun) return deps.execPath ?? process.execPath;

  // 3. Busca no pacote npm "bun" (nossa dependência)
  const platform = deps.platform ?? process.platform;
  const resolve = deps.resolve ?? createRequire(import.meta.url).resolve;
  const binName = platform === "win32" ? "bun.exe" : "bun";

  try {
    // Resolve o caminho do package.json do pacote "bun" e monta o caminho do binário
    const manifest = resolve("bun/package.json");
    const candidate = join(dirname(manifest), "bin", binName);
    if (exists(candidate)) return candidate;
  } catch {
    // O pacote bun não foi encontrado no node_modules (pode ter sido omitido)
  }

  // 4. Fallback: Busca no PATH do sistema
  const onPath = (deps.which ?? ((name) => whichFromPath(name, env)))(binName);
  if (onPath !== undefined) return onPath;

  throw missingRuntime();
}

/** Argumentos do Bun: o CLI publicado seguido dos argumentos do usuário. */
export function bunArgs(cliPath: string, argv: readonly string[]): string[] {
  return [cliPath, ...argv];
}

/**
 * Compara o entrypoint com o módulo resolvendo symlinks/junctions: no npm POSIX
 * o bin global é um link para `dist/launcher.js`, e `argv[1]` guarda o link.
 */
export function isMainEntry(
  entry: string | undefined,
  modulePath: string,
  realpath: (path: string) => string = realpathSync.native,
): boolean {
  if (entry === undefined) return false;
  try {
    return realpath(entry) === realpath(modulePath);
  } catch {
    return false;
  }
}

function isMain(): boolean {
  return isMainEntry(process.argv[1], fileURLToPath(import.meta.url));
}

function main(): void {
  let bun: string;
  try {
    bun = resolveBun();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`astro: ${message}`);
    process.exit(1);
  }

  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(bun, bunArgs(cli, process.argv.slice(2)), { stdio: "inherit", env: process.env });
  
  child.on("error", (error) => {
    console.error(`astro: falha ao executar o Bun: ${error.message}`);
    process.exit(1);
  });
  
  child.on("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (isMain()) main();