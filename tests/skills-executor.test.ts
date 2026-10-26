import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { buildSkillRegistry, isSkillCommand, resolveSkillCommand, resolveTaskSkill } from "../src/skills/executor";
import { loadSkillsFromRoot } from "../src/skills/loader";

const SKILL = `---\nname: commit\ndescription: Cria um commit com a mudança atual\nversion: 1.0.0\npermissions:\n  tools: [read_file, run_command]\n---\nRevise o diff e crie o commit. Argumentos: $ARGUMENTS\n`;
const SKILL_SCRIPTS = SKILL.replace("---\nRevise", "scripts:\n  - name: check\n    command: git status --short\n---\nRevise");

function skillDir(root: string, name: string, body = SKILL): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  return dir;
}
function newRoots() {
  const projectRoot = mkdtempSync(join(tmpdir(), "astro-skexec-p-"));
  const userRoot = mkdtempSync(join(tmpdir(), "astro-skexec-u-"));
  return { projectRoot, userRoot };
}

test("resolveSkillCommand substitui $ARGUMENTS, anexa scripts e falha fechado", () => {
  const { projectRoot, userRoot } = newRoots();
  skillDir(projectRoot, "commit", SKILL_SCRIPTS);
  const registry = buildSkillRegistry({ projectRoot, userRoot, warn: () => {} });
  const allow = ["read_file", "run_command"];

  expect(isSkillCommand("task sem barra")).toBe(false);
  expect(isSkillCommand("/commit")).toBe(true);

  const invocation = resolveSkillCommand("/commit revisar o diff", { registry, allow })!;
  expect(invocation.skill.manifest.name).toBe("commit");
  expect(invocation.prompt).toContain("Revise o diff e crie o commit.");
  expect(invocation.prompt).toContain("revisar o diff");
  expect(invocation.prompt).toContain("- check: git status --short");

  expect(() => resolveSkillCommand("/ausente", { registry, allow })).toThrow(/não encontrada/);
  expect(() => resolveSkillCommand("tarefa normal", { registry, allow })).not.toThrow();

  skillDir(userRoot, "commit", SKILL.replace("Cria um commit", "Commit do usuário"));
  const ambiguous = buildSkillRegistry({ projectRoot, userRoot, warn: () => {} });
  expect(() => resolveSkillCommand("/commit", { registry: ambiguous, allow })).toThrow(/ambíguo/);

  skillDir(projectRoot, "deploy", SKILL.replace("name: commit", "name: deploy"));
  const strict = buildSkillRegistry({ projectRoot, userRoot, warn: () => {} });
  expect(() => resolveSkillCommand("/deploy", { registry: strict, allow: ["read_file"] })).toThrow(/allowlist/);
});

test("loadSkillsFromRoot não segue links de diretório e avisa", () => {
  const root = mkdtempSync(join(tmpdir(), "astro-sklink-"));
  const outside = mkdtempSync(join(tmpdir(), "astro-sklink-out-"));
  const target = skillDir(outside, "real");
  symlinkSync(target, join(root, "linked"), "junction");
  skillDir(root, "commit");
  const warnings: string[] = [];
  const skills = loadSkillsFromRoot(root, "project", (message) => warnings.push(message));

  expect(skills.map((skill) => skill.manifest.name)).toEqual(["commit"]);
  expect(warnings.join("\n")).toMatch(/linked.*link não seguido/);
});

test("resolveTaskSkill audita skill.loaded e devolve a task normal quando não é comando", () => {
  const { projectRoot, userRoot } = newRoots();
  skillDir(join(projectRoot, ".astro", "skills"), "commit", SKILL_SCRIPTS);
  const auditDir = mkdtempSync(join(tmpdir(), "astro-skexec-a-"));
  const audit = new Auditor(join(auditDir, "audit.jsonl"));
  const opts = { cwd: projectRoot, userRoot, allow: ["read_file", "run_command"], audit, run: "r1", agent: "default" };

  const prompt = resolveTaskSkill("/commit ajuste fino", opts);
  expect(prompt).toContain("ajuste fino");
  expect(prompt).toContain("git status --short");
  const loaded = audit.readAll().find((event) => event.tipo === "skill.loaded");
  expect(loaded).toMatchObject({
    run: "r1",
    tipo: "skill.loaded",
    payload: { name: "commit", version: "1.0.0", source: "project" },
  });
  expect((loaded!.payload as { sha256?: string }).sha256).toMatch(/^[0-9a-f]{64}$/);

  expect(resolveTaskSkill("tarefa comum", opts)).toBe("tarefa comum");
});

test("run via /commit injeta o prompt da skill, audita skill.loaded e não persiste conteúdo", async () => {
  const seen: { messages: { role: string; content: string }[] }[] = [];
  const up = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push((await req.json()) as { messages: { role: string; content: string }[] });
      return Response.json({ choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-skexec-run-"));
    skillDir(join(dir, ".astro", "skills"), "commit", SKILL_SCRIPTS);
    const cfgPath = join(dir, "astro.config.json");
    writeFileSync(cfgPath, JSON.stringify({
      providers: { a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${up.port}/v1`, credentialRef: "KEY_A" } },
      models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 4096 }],
      agent: { model: "a/m1", maxSteps: 2, tools: ["read_file", "run_command"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const report = await runTask({
      configPath: cfgPath, task: "/commit revisar o diff", cwd: dir,
      env: { KEY_A: "dummy" }, skillsUserRoot: join(dir, "sem-skills"),
    });

    expect(report.final).toBe("pronto");
    const userMessage = seen[0]!.messages.find((message) => message.role === "user")!;
    expect(userMessage.content).toContain("Revise o diff e crie o commit.");
    expect(userMessage.content).toContain("revisar o diff");
    expect(userMessage.content).toContain("- check: git status --short");

    const auditText = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(auditText).toContain("skill.loaded");
    expect(auditText).toContain("\"name\":\"commit\"");
    expect(auditText).not.toContain("Revise o diff"); // prompt da skill não é persistido (I-04)
  } finally {
    up.stop(true);
  }
});

test("run com skill pedindo tool fora da allowlist falha fechado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-skexec-deny-"));
  skillDir(join(dir, ".astro", "skills"), "deploy", SKILL.replace("name: commit", "name: deploy").replace("tools: [read_file, run_command]", "tools: [write_file]"));
  const cfgPath = join(dir, "astro.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    providers: { a: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY_A" } },
    models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "a/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  await expect(runTask({
    configPath: cfgPath, task: "/deploy agora", cwd: dir,
    env: { KEY_A: "dummy" }, skillsUserRoot: join(dir, "sem-skills"),
  })).rejects.toThrow(/allowlist/);
  const auditText = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
  expect(auditText).toContain("run.started");
  expect(auditText).toContain("run.stopped");
  expect(auditText).not.toContain("skill.loaded");
});
