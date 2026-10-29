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

/** Nome dos pacotes de binário do Bun para a plataforma (arm64 vira aarch64). */
export function platformPackages(platform: string, arch: string): string[] {
  const cpu = arch === "arm64" ? "aarch64" : arch;
  switch (platform) {
    case "win32": return [`@oven/bun-windows-${cpu}`];
    case "darwin": return [`@oven/bun-darwin-${cpu}`];
    case "linux": return [`@oven/bun-linux-${cpu}`, `@oven/bun-linux-${cpu}-musl`];
    case "android": return [`@oven/bun-linux-${cpu}-android`];
    case "freebsd": return [`@oven/bun-freebsd-${cpu}`];
    default: return [];
  }
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
    "runtime Bun não encontrado. Reinstale sem --omit=optional:\n" +
    "  npm install -g @umtioai/astro-harness@alpha\n" +
    "ou aponte para um Bun existente:\n" +
    "  ASTRO_BUN_PATH=/caminho/para/bun astro --help",
  );
}

/**
 * Ordem: ASTRO_BUN_PATH → Bun que está executando → binário da dependência de
 * plataforma → bun no PATH.
 */
export function resolveBun(deps: ResolveDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const explicit = env.ASTRO_BUN_PATH;
  if (explicit !== undefined && explicit !== "") {
    if (!exists(explicit)) {
      throw new MissingBunError(`ASTRO_BUN_PATH aponta para "${explicit}", que não existe`);
    }
    return explicit;
  }

  const runningUnderBun = deps.runningUnderBun
    ?? typeof (process.versions as Record<string, string | undefined>).bun === "string";
  if (runningUnderBun) return deps.execPath ?? process.execPath;

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const resolve = deps.resolve ?? createRequire(import.meta.url).resolve;
  const binName = platform === "win32" ? "bun.exe" : "bun";

  for (const pkg of platformPackages(platform, arch)) {
    try {
      const manifest = resolve(`${pkg}/package.json`);
      const candidate = join(dirname(manifest), "bin", binName);
      if (exists(candidate)) return candidate;
    } catch {
      // pacote opcional não instalado para esta plataforma/libc
    }
  }

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
