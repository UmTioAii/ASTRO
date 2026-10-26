import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runSkillsCommand } from "../src/skills/cli";
import { installSkill, removeSkill, verifySkill } from "../src/skills/installer";

const SKILL = `---\nname: commit\ndescription: Cria um commit com a mudança atual\nversion: 1.0.0\npermissions:\n  tools: [read_file, run_command]\n---\nRevise o diff e crie o commit.\n`;

function skillDir(root: string, name: string, body = SKILL): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
}

test("installer copia skill local, grava sidecar, audita e verify detecta alteração", async () => {
  const source = mkdtempSync(join(tmpdir(), "astro-sksrc-"));
  const target = mkdtempSync(join(tmpdir(), "astro-skdst-"));
  const audit = new Auditor(join(target, "audit.jsonl"));

  const installed = await installSkill({ source: skillDir(source, "commit"), root: target, sourceKind: "project", audit, run: "r1" });
  expect(installed.manifest.name).toBe("commit");
  expect(installed.manifest.source).toBe("project");

  const file = join(target, "commit", "SKILL.md");
  expect(readFileSync(join(target, "commit", ".sha256"), "utf8").trim()).toBe(installed.manifest.sha256);
  expect(verifySkill(target, "commit").ok).toBe(true);
  expect(audit.readAll()[0]).toMatchObject({
    run: "r1",
    tipo: "skill.installed",
    payload: { name: "commit", version: "1.0.0", sha256: installed.manifest.sha256, source: "project" },
  });

  writeFileSync(file, `${readFileSync(file, "utf8")}Mudou.`);
  const tampered = verifySkill(target, "commit");
  expect(tampered.ok).toBe(false);
  expect(tampered.reason).toMatch(/sha256/);

  removeSkill(target, "commit");
  expect(verifySkill(target, "commit").ok).toBe(false);
});

test("installer baixa de URL e exige force para substituir", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(SKILL) });
  const target = mkdtempSync(join(tmpdir(), "astro-skurl-"));
  try {
    const url = `http://127.0.0.1:${server.port}/SKILL.md`;
    const installed = await installSkill({ source: url, root: target, sourceKind: "user" });
    expect(installed.manifest.source).toBe("user");
    expect(verifySkill(target, "commit").ok).toBe(true);
    await expect(installSkill({ source: url, root: target, sourceKind: "user" })).rejects.toThrow(/instalada/);
    const replaced = await installSkill({ source: url, root: target, sourceKind: "user", force: true });
    expect(replaced.manifest.sha256).toBe(installed.manifest.sha256);
  } finally {
    server.stop(true);
  }
});

test("installer recusa origem que sobrepõe o destino e não apaga a skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "astro-skov-"));
  const dir = skillDir(root, "commit"); // instalar em root de novo = origem é o destino
  await expect(installSkill({ source: dir, root, sourceKind: "project", force: true })).rejects.toThrow(/sobrepõem/);
  const kept = verifySkill(root, "commit");
  expect(kept.ok).toBe(false);
  expect(kept.reason).toMatch(/sha256 não registrado/);

  const wrapper = mkdtempSync(join(tmpdir(), "astro-skov2-")); // origem contém o destino
  writeFileSync(join(wrapper, "SKILL.md"), SKILL);
  await expect(installSkill({ source: wrapper, root: wrapper, sourceKind: "project" })).rejects.toThrow(/sobrepõem/);
});

test("skills list/show/validate respeitam namespace, ambiguidade e uso", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "astro-skp-"));
  const userRoot = mkdtempSync(join(tmpdir(), "astro-sku-"));
  skillDir(projectRoot, "commit");
  skillDir(userRoot, "review", SKILL.replace("name: commit", "name: review"));
  const lines: string[] = [];
  const opts = { projectRoot, userRoot, auditPath: join(projectRoot, "audit.jsonl"), out: (line: string) => lines.push(line) };

  expect(await runSkillsCommand(["list"], opts)).toBe(0);
  expect(lines.some((line) => line.includes("project/commit"))).toBe(true);
  expect(lines.some((line) => line.includes("user/review"))).toBe(true);

  lines.length = 0;
  expect(await runSkillsCommand(["show", "project/commit"], opts)).toBe(0);
  expect(lines.join("\n")).toContain("Revise o diff");

  skillDir(userRoot, "commit", SKILL.replace("Cria um commit", "Commit do usuário"));
  expect(await runSkillsCommand(["show", "commit"], opts)).toBe(1);
  expect(await runSkillsCommand(["show", "user/commit"], opts)).toBe(0);
  expect(await runSkillsCommand(["validate", "user/review"], opts)).toBe(0);
  expect(await runSkillsCommand(["validate", "ausente"], opts)).toBe(1);
  expect(await runSkillsCommand([], opts)).toBe(1);
  expect(await runSkillsCommand(["desconhecido"], opts)).toBe(1);
});

test("skills install/remove/verify usam a raiz pedida e auditam", async () => {
  const source = mkdtempSync(join(tmpdir(), "astro-sksrc2-"));
  skillDir(source, "deploy", SKILL.replace("name: commit", "name: deploy"));
  const projectRoot = mkdtempSync(join(tmpdir(), "astro-skp2-"));
  const userRoot = mkdtempSync(join(tmpdir(), "astro-sku2-"));
  const auditPath = join(projectRoot, "audit.jsonl");
  const lines: string[] = [];
  const opts = { projectRoot, userRoot, auditPath, out: (line: string) => lines.push(line) };
  expect(await runSkillsCommand(["install", join(source, "deploy")], opts)).toBe(0);
  expect(verifySkill(projectRoot, "deploy").ok).toBe(true);
  expect(new Auditor(auditPath).readAll()[0]).toMatchObject({
    tipo: "skill.installed",
    payload: { name: "deploy", source: "project" },
  });

  expect(await runSkillsCommand(["install", join(source, "deploy"), "--user"], opts)).toBe(0);
  expect(verifySkill(userRoot, "deploy").ok).toBe(true);

  expect(await runSkillsCommand(["verify", "deploy"], opts)).toBe(0);
  expect(await runSkillsCommand(["remove", "deploy"], opts)).toBe(0);
  expect(verifySkill(projectRoot, "deploy").ok).toBe(false);
  expect(await runSkillsCommand(["remove", "deploy", "--user"], opts)).toBe(0);
  expect(verifySkill(userRoot, "deploy").ok).toBe(false);
  expect(await runSkillsCommand(["remove", "deploy"], opts)).toBe(1);
});
