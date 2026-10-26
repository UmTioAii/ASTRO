import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Auditor } from "../audit";
import { parseSkill } from "./loader";
import { SKILL_NAME_RE, SkillError, type Skill, type SkillSource } from "./types";

/** Teto do conteúdo baixado/instalado (sugestão 3 da revisão da C1a). */
const MAX_SKILL_BYTES = 1_000_000;

/** Caminho físico: realpath do ancestral existente mais fundo; normaliza caixa (win32) e junction. */
function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? resolve(path) : join(physicalPath(parent), basename(path));
  }
}

export interface InstallSkillOptions {
  /** URL http(s) ou caminho local de um SKILL.md ou diretório de skill. */
  source: string;
  /** Raiz que recebe `<name>/SKILL.md` (raiz project ou user). */
  root: string;
  /** Fonte registrada no manifesto e no audit. */
  sourceKind: SkillSource;
  audit?: Auditor;
  run?: string;
  /** Permite substituir instalação existente. */
  force?: boolean;
  fetchFn?: (url: string) => Promise<Response>;
}

export interface VerifyResult {
  ok: boolean;
  sha256?: string;
  reason?: string;
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function readSource(
  source: string,
  fetchFn: (url: string) => Promise<Response>,
): Promise<{ content: string; directory?: string }> {
  if (isUrl(source)) {
    let response: Response;
    try {
      response = await fetchFn(source);
    } catch (error) {
      throw new SkillError(`falha ao baixar skill "${source}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new SkillError(`falha ao baixar skill "${source}": HTTP ${response.status}`);
    const content = await response.text();
    if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new SkillError(`skill "${source}": maior que ${MAX_SKILL_BYTES} bytes`);
    return { content };
  }

  const absolute = resolve(source);
  if (!existsSync(absolute)) throw new SkillError(`skill "${source}": caminho não encontrado`);
  const directory = statSync(absolute).isDirectory() ? absolute : undefined;
  const file = directory === undefined ? absolute : join(directory, "SKILL.md");
  if (!existsSync(file)) throw new SkillError(`skill "${source}": SKILL.md não encontrado`);
  const content = readFileSync(file, "utf8");
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new SkillError(`skill "${file}": maior que ${MAX_SKILL_BYTES} bytes`);
  return { content, ...(directory === undefined ? {} : { directory }) };
}

/** Instala em `<root>/<name>/` com sidecar `.sha256`; existente exige `force`; sha = `parseSkill` (sem BOM). */
export async function installSkill(opts: InstallSkillOptions): Promise<Skill> {
  const { content, directory } = await readSource(opts.source, opts.fetchFn ?? fetch);
  const root = resolve(opts.root);
  const parsed = parseSkill(content, opts.sourceKind, join(root, "SKILL.md"));
  const name = parsed.manifest.name;
  if (!SKILL_NAME_RE.test(name)) throw new SkillError(`skill "${name}": nome inválido`);

  const targetDir = join(root, name);
  if (directory !== undefined) {
    // Sobreposição é física (realpath) e, no win32, case-insensitive como o SO.
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const sourcePhys = norm(physicalPath(directory));
    const destPhys = norm(physicalPath(targetDir));
    if (sourcePhys === destPhys || sourcePhys.startsWith(`${destPhys}${sep}`) || destPhys.startsWith(`${sourcePhys}${sep}`)) {
      throw new SkillError(`skill "${name}": origem e destino se sobrepõem (${directory} x ${targetDir})`);
    }
  }
  if (existsSync(targetDir)) {
    if (opts.force !== true) {
      throw new SkillError(`skill "${name}": já instalada em ${targetDir}; use --force para substituir`);
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  if (directory !== undefined) {
    mkdirSync(root, { recursive: true });
    cpSync(directory, targetDir, { recursive: true, dereference: true, filter: (path) => basename(path) !== ".sha256" });
  } else {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "SKILL.md"), content);
  }

  writeFileSync(join(targetDir, ".sha256"), `${parsed.manifest.sha256}\n`);
  opts.audit?.append({
    run: opts.run ?? `skills-${randomUUID()}`,
    agent: "skills",
    tipo: "skill.installed",
    payload: { name, version: parsed.manifest.version, sha256: parsed.manifest.sha256, source: opts.sourceKind },
  });

  return { ...parsed, manifest: { ...parsed.manifest, path: join(targetDir, "SKILL.md") } };
}

/** Recalcula o sha256 pelo `parseSkill` e compara com o sidecar da instalação. */
export function verifySkill(root: string, name: string): VerifyResult {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, reason: "nome inválido" };
  const directory = join(resolve(root), name);
  const file = join(directory, "SKILL.md");
  const sidecar = join(directory, ".sha256");
  if (!existsSync(file)) return { ok: false, reason: `skill "${name}" não instalada` };
  if (!existsSync(sidecar)) return { ok: false, reason: "sha256 não registrado (skill instalada sem sidecar)" };

  const actual = parseSkill(readFileSync(file, "utf8"), "project", file).manifest.sha256;
  const expected = readFileSync(sidecar, "utf8").trim();
  if (actual !== expected) {
    return { ok: false, sha256: actual, reason: `sha256 não confere: esperado ${expected}` };
  }
  return { ok: true, sha256: actual };
}

/** Remove a skill instalada; devolve false quando ela não existe. */
export function removeSkill(root: string, name: string): boolean {
  if (!SKILL_NAME_RE.test(name)) throw new SkillError(`skill "${name}": nome inválido`);
  const directory = join(resolve(root), name);
  if (!existsSync(directory)) return false;
  rmSync(directory, { recursive: true, force: true });
  return true;
}
