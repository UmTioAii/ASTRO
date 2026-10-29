/**
 * Smoke local do artefato: roda o launcher gerado com Node e sem Bun no PATH,
 * provando que ele resolve o Bun empacotado. Não usa rede nem publica nada.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { platformPackages } from "../src/launcher";
import { smokeEnv } from "./smoke-env";

const root = resolve(import.meta.dir, "..");
const cli = join(root, "dist", "cli.js");
const launcher = join(root, "dist", "launcher.js");

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

for (const file of [cli, launcher]) {
  if (!existsSync(file)) fail(`${file} não existe; rode bun run build`);
}

const node = Bun.which("node");
if (node === null) fail("node não encontrado no PATH; o smoke testa o launcher Node");
const nodeBin: string = node;

const firstLine = (file: string): string => readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
if (!firstLine(launcher).startsWith("#!/usr/bin/env node")) fail("dist/launcher.js sem shebang node");
if (!firstLine(cli).startsWith("#!/usr/bin/env bun")) fail("dist/cli.js sem shebang bun");

const system = process.platform === "win32"
  ? [dirname(nodeBin), process.env.SystemRoot === undefined ? "C:\\Windows\\System32" : join(process.env.SystemRoot, "System32")]
  : [dirname(nodeBin), "/usr/bin", "/bin"];
const env = smokeEnv(process.env, system);
delete env.ASTRO_BUN_PATH;
delete env.BUN_INSTALL;

const binName = process.platform === "win32" ? "bun.exe" : "bun";
const requireFromDist = createRequire(launcher);
const resolved = platformPackages(process.platform, process.arch).some((pkg) => {
  try {
    const manifest = requireFromDist.resolve(`${pkg}/package.json`);
    return existsSync(join(dirname(manifest), "bin", binName));
  } catch {
    return false;
  }
});
if (!resolved) {
  fail(
    `nenhum ${platformPackages(process.platform, process.arch).join(" / ")} resolvido a partir de dist/launcher.js; ` +
    "rode bun install",
  );
}

function run(args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([nodeBin, launcher, ...args], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

const help = run(["--help"]);
if (help.code !== 0 || !help.out.includes("astro run")) {
  fail(`astro --help falhou (exit ${help.code})\n${help.err}${help.out}`);
}

const bare = run([]);
if (bare.code !== 0 || !bare.out.includes("Uso:")) {
  fail(`astro sem args em pipe não imprimiu o help (exit ${bare.code})\n${bare.err}${bare.out}`);
}

console.log("smoke ok: launcher Node resolve o Bun empacotado sem Bun no PATH");
