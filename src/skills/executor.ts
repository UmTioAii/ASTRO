import { homedir } from "node:os";
import { join } from "node:path";
import type { Auditor } from "../audit";
import { loadSkillsFromRoot } from "./loader";
import { SkillRegistry } from "./registry";
import { SkillError, type Skill, type SkillSource } from "./types";

/** Comando de skill: task começando com `/nome` (nome igual ao do manifesto). */
const SLASH_COMMAND = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/;

export function isSkillCommand(task: string): boolean {
  return SLASH_COMMAND.test(task);
}

export interface BuildRegistryOptions {
  projectRoot: string;
  userRoot: string;
  warn?: (message: string) => void;
}

/** Registro das duas raízes (project antes de user); conflito vira warn, não derruba a carga. */
export function buildSkillRegistry(opts: BuildRegistryOptions): SkillRegistry {
  const registry = new SkillRegistry();
  const warn = opts.warn ?? ((message: string) => console.warn(`skills: ${message}`));
  const roots: [string, SkillSource][] = [
    [opts.projectRoot, "project"],
    [opts.userRoot, "user"],
  ];
  for (const [root, source] of roots) {
    for (const skill of loadSkillsFromRoot(root, source, warn)) {
      try {
        registry.register(skill);
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return registry;
}

export interface ResolveSkillOptions {
  registry: SkillRegistry;
  /** Allowlist de tools do agent (I-01). */
  allow: readonly string[];
}

export interface SkillInvocation {
  skill: Skill;
  /** Prompt da skill com `$ARGUMENTS` substituído e scripts declarados anexados. */
  prompt: string;
}

/**
 * Resolve `/nome args`: skills pedindo tool fora da allowlist do agent falham
 * fechado (I-01). Task sem comando de skill devolve undefined.
 */
export function resolveSkillCommand(task: string, opts: ResolveSkillOptions): SkillInvocation | undefined {
  const match = SLASH_COMMAND.exec(task);
  if (match === null) return undefined;
  const name = match[1]!;
  const skill = opts.registry.get(name);
  if (skill === undefined) throw new SkillError(`skill "${name}" não encontrada`);
  const missing = skill.manifest.permissions.tools.filter((tool) => !opts.allow.includes(tool));
  if (missing.length > 0) {
    throw new SkillError(`skill "${name}" pede tools fora da allowlist do agent: ${missing.join(", ")}`);
  }
  let prompt = skill.prompt.replaceAll("$ARGUMENTS", (match[2] ?? "").trim());
  if (skill.manifest.scripts.length > 0) {
    const scripts = skill.manifest.scripts.map((script) => `- ${script.name}: ${script.command}`).join("\n");
    prompt += `\n\nScripts declarados (via run_command, sujeitos a sandbox e timeout):\n${scripts}`;
  }
  return { skill, prompt };
}

export interface SkillTaskOptions {
  cwd: string;
  /** Raiz de skills do usuário; default `~/.astro/skills` (injetável para teste). */
  userRoot?: string;
  allow: readonly string[];
  audit: Auditor;
  run: string;
  agent: string;
}

/**
 * Task de entrada vista pelo modelo: comandos `/nome` viram o prompt da skill
 * (com `$ARGUMENTS` e scripts), `skill.loaded` {name, version, sha256, source}
 * é auditado e o conteúdo da task/prompt nunca é persistido (I-04).
 */
export function resolveTaskSkill(task: string, opts: SkillTaskOptions): string {
  if (!isSkillCommand(task)) return task;
  const registry = buildSkillRegistry({
    projectRoot: join(opts.cwd, ".astro", "skills"),
    userRoot: opts.userRoot ?? join(homedir(), ".astro", "skills"),
  });
  const invocation = resolveSkillCommand(task, { registry, allow: opts.allow });
  if (invocation === undefined) return task;
  const { manifest } = invocation.skill;
  opts.audit.append({
    run: opts.run,
    agent: opts.agent,
    tipo: "skill.loaded",
    payload: { name: manifest.name, version: manifest.version, sha256: manifest.sha256, source: manifest.source },
  });
  return invocation.prompt;
}
