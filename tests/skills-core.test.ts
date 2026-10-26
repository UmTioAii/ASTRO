import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillFile, loadSkillsFromRoot, parseSkill } from "../src/skills/loader";
import { SkillRegistry } from "../src/skills/registry";

const SKILL = `---
name: commit
description: Cria um commit com a mudança atual
version: 1.0.0
permissions:
  tools: [read_file, run_command]
  network: false
  filesystem: write
scripts:
  - name: check
    command: git status --short
---
Revise o diff e crie o commit. Argumentos: $ARGUMENTS
`;

function skillDir(root: string, name: string, body = SKILL): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
}

test("loader parseia frontmatter YAML, permissões, scripts e sha256", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-skill-"));
  const path = join(skillDir(dir, "commit"), "SKILL.md");
  const skill = loadSkillFile(path, "project");

  expect(skill.manifest).toMatchObject({
    name: "commit", description: "Cria um commit com a mudança atual", version: "1.0.0", source: "project",
    permissions: { tools: ["read_file", "run_command"], network: false, filesystem: "write" },
    scripts: [{ name: "check", command: "git status --short" }],
  });
  expect(skill.prompt).toContain("Revise o diff");
  expect(skill.manifest.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(path, "utf8")).digest("hex"));
});

test("loader rejeita manifesto incompleto ou nome inválido", () => {
  const invalid = (body: string) => () => parseSkill(body, "project", "/tmp/SKILL.md");
  expect(invalid(SKILL.replace("version: 1.0.0\n", ""))).toThrow(/version/);
  expect(invalid(SKILL.replace("name: commit", "name: ../escape"))).toThrow(/name/);
  expect(invalid(SKILL.replace("Revise o diff e crie o commit. Argumentos: $ARGUMENTS", ""))).toThrow(/prompt/);
});

test("registry separa fontes e recusa conflito de versão", () => {
  const project = parseSkill(SKILL, "project", "/p/commit/SKILL.md");
  const user = parseSkill(SKILL.replace("Cria um commit", "Cria commit do usuário"), "user", "/u/commit/SKILL.md");
  const registry = new SkillRegistry();
  registry.register(project);
  registry.register(user);

  expect(registry.get("project/commit")?.manifest.description).toContain("atual");
  expect(registry.get("user/commit")?.manifest.description).toContain("usuário");
  expect(() => registry.get("commit")).toThrow(/ambíguo/);
  expect(() => registry.register(parseSkill(SKILL.replace("1.0.0", "2.0.0"), "project", "/p/commit/SKILL.md"))).toThrow(/conflito/);
});

test("loadSkillsFromRoot isola skill inválida e mantém as válidas", () => {
  const root = mkdtempSync(join(tmpdir(), "astro-skills-"));
  skillDir(root, "commit");
  skillDir(root, "broken", "---\nname: broken\n---\nsem versão");
  const warnings: string[] = [];
  const skills = loadSkillsFromRoot(root, "project", (message) => warnings.push(message));

  expect(skills.map((skill) => skill.manifest.name)).toEqual(["commit"]);
  expect(warnings[0]).toContain("broken");
});

test("loader aceita YAML válido: versão numérica, lista no nível da chave e comentário inline", () => {
  const numeric = parseSkill(SKILL.replace("version: 1.0.0", "version: 1.0"), "project", "/p/SKILL.md");
  expect(numeric.manifest.version).toBe("1.0");
  const flat = parseSkill(SKILL.replace("  - name: check\n    command: git status --short", "- name: check\n  command: git status --short"), "project", "/p/SKILL.md");
  expect(flat.manifest.scripts).toEqual([{ name: "check", command: "git status --short" }]);
  expect(parseSkill(SKILL.replace("version: 1.0.0", "version: 1.0.0 # estável"), "project", "/p/SKILL.md").manifest.version).toBe("1.0.0");
});

test("loader rejeita chave __proto__ no frontmatter", () => {
  const polluted = SKILL.replace("name: commit\n", "__proto__:\n  name: evil\n");
  expect(() => parseSkill(polluted, "project", "/p/SKILL.md")).toThrow(/__proto__/);
});

test("parser não engole item irmão depois de lista aninhada no item", () => {
  const nested = SKILL.replace("  - name: check\n    command: git status --short", "  - name: a\n    command: x\n    args:\n      - one\n  - name: b\n    command: y");
  expect(parseSkill(nested, "project", "/p/SKILL.md").manifest.scripts).toEqual([{ name: "a", command: "x" }, { name: "b", command: "y" }]);
});

test("chave dedentada ao indent dos itens não sobrescreve o root", () => {
  const stray = SKILL.replace("  - name: check\n    command: git status --short", "  - name: check\n    command: git status --short\n  version: 9.9.9");
  expect(() => parseSkill(stray, "project", "/p/SKILL.md")).toThrow(/indentação/);
});
