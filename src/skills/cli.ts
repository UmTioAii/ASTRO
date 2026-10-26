import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../audit";
import { installSkill, removeSkill, verifySkill } from "./installer";
import { loadSkillsFromRoot } from "./loader";
import { SkillRegistry } from "./registry";
import type { SkillSource } from "./types";

const USAGE_SKILLS = `uso: skills <subcomando> [--user] [--force]
  list                  lista skills do projeto (.astro/skills) e do usuário (~/.astro/skills)
  show <nome>           mostra manifesto e prompt; aceita fonte/nome (project/commit)
  validate <nome>       valida manifesto da skill; aceita fonte/nome
  install <url|caminho> instala na raiz do projeto; --user instala em ~/.astro/skills
  remove <nome>         remove da raiz do projeto; --user remove da do usuário
  verify <nome>         confere o sha256 do sidecar da instalação`;

/** Raízes e saída injetáveis para teste; defaults seguem o convênio do ASTRO. */
export interface SkillsCliOptions {
  cwd?: string;
  projectRoot?: string;
  userRoot?: string;
  auditPath?: string;
  fetchFn?: (url: string) => Promise<Response>;
  out?: (line: string) => void;
}

/** CLI de skills (C1b): list | show | validate | install | remove | verify. */
export async function runSkillsCommand(argv: string[], opts: SkillsCliOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const projectRoot = opts.projectRoot ?? join(cwd, ".astro", "skills");
  const userRoot = opts.userRoot ?? join(homedir(), ".astro", "skills");
  const out = opts.out ?? ((line: string) => console.log(line));
  const [sub, ...rest] = argv;

  if (argv.length === 0 || sub === "help" || sub === "--help") {
    out(USAGE_SKILLS);
    return argv.length === 0 ? 1 : 0;
  }

  const user = rest.includes("--user");
  const force = rest.includes("--force");
  const args = rest.filter((arg) => arg !== "--user" && arg !== "--force");
  const root = user ? userRoot : projectRoot;
  const sourceKind: SkillSource = user ? "user" : "project";

  const loadRegistry = (): SkillRegistry => {
    const registry = new SkillRegistry();
    const warn = (message: string) => out(`aviso: ${message}`);
    for (const skill of loadSkillsFromRoot(projectRoot, "project", warn)) registry.register(skill);
    for (const skill of loadSkillsFromRoot(userRoot, "user", warn)) registry.register(skill);
    return registry;
  };
  const needName = (): string | undefined => args[0];

  try {
    switch (sub) {
      case "list": {
        for (const skill of loadRegistry().list()) {
          out(`${skill.manifest.source}/${skill.manifest.name}  ${skill.manifest.version}  ${skill.manifest.description}`);
        }
        return 0;
      }
      case "show":
      case "validate": {
        const name = needName();
        if (name === undefined) { out(USAGE_SKILLS); return 1; }
        const skill = loadRegistry().require(name);
        if (sub === "validate") { out(`ok: ${skill.manifest.source}/${skill.manifest.name} ${skill.manifest.version}`); return 0; }
        const { manifest } = skill;
        out(`${manifest.source}/${manifest.name} ${manifest.version} — ${manifest.description}`);
        out(`permissões: tools [${manifest.permissions.tools.join(", ")}], network ${manifest.permissions.network}, filesystem ${manifest.permissions.filesystem}`);
        if (manifest.scripts.length > 0) out(`scripts: ${manifest.scripts.map((s) => s.name).join(", ")}`);
        out("---");
        out(skill.prompt);
        return 0;
      }
      case "install": {
        const source = args[0];
        if (source === undefined) { out(USAGE_SKILLS); return 1; }
        const audit = new Auditor(opts.auditPath ?? join(cwd, ".astro", "audit.jsonl"));
        const skill = await installSkill({
          source, root, sourceKind, audit, force,
          run: `skills-${randomUUID()}`,
          ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
        });
        out(`instalada: ${skill.manifest.source}/${skill.manifest.name} ${skill.manifest.version} (sha256 ${skill.manifest.sha256.slice(0, 12)})`);
        return 0;
      }
      case "remove": {
        const name = needName();
        if (name === undefined) { out(USAGE_SKILLS); return 1; }
        if (!removeSkill(root, name)) { out(`erro: skill "${name}" não encontrada em ${root}`); return 1; }
        out(`removida: ${name} (de ${root})`);
        return 0;
      }
      case "verify": {
        const name = needName();
        if (name === undefined) { out(USAGE_SKILLS); return 1; }
        const result = verifySkill(root, name);
        if (!result.ok) { out(`erro: ${result.reason}`); return 1; }
        out(`ok: ${name} sha256 ${result.sha256}`);
        return 0;
      }
      default:
        out(`subcomando desconhecido: "${sub}"`);
        out(USAGE_SKILLS);
        return 1;
    }
  } catch (error) {
    out(`erro: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
