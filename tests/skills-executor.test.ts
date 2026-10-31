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
function writeRunConfig(dir: string, port: number, tools: string[]): string {
  const cfgPath = join(dir, "astro.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    providers: { a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "KEY_A" } },
    models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "a/m1", maxSteps: 3, tools },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return cfgPath;
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

  // chave completa desambigua (a mensagem de ambiguidade manda usar exatamente isto)
  const namespaced = resolveSkillCommand("/project/commit revisar o diff", { registry, allow })!;
  expect(namespaced.skill.manifest.source).toBe("project");
  expect(namespaced.prompt).toContain("revisar o diff");

  expect(() => resolveSkillCommand("/ausente", { registry, allow })).toThrow(/não encontrada/);
  expect(() => resolveSkillCommand("tarefa normal", { registry, allow })).not.toThrow();

  skillDir(userRoot, "commit", SKILL.replace("Cria um commit", "Commit do usuário"));
  const ambiguous = buildSkillRegistry({ projectRoot, userRoot, warn: () => {} });
  expect(() => resolveSkillCommand("/commit", { registry: ambiguous, allow })).toThrow(/ambíguo/);
  const viaUser = resolveSkillCommand("/user/commit", { registry: ambiguous, allow })!;
  expect(viaUser.skill.manifest.source).toBe("user");

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
  expect(loaded).toMatchObject({ run: "r1", tipo: "skill.loaded", payload: { name: "commit", version: "1.0.0", source: "project" } });
  expect((loaded!.payload as { sha256?: string }).sha256).toMatch(/^[0-9a-f]{64}$/);

  expect(resolveTaskSkill("tarefa comum", opts)).toBe("tarefa comum");
});

test("loadSkillsFromRoot recusa SKILL.md acima do teto de 1MB", () => {
  const root = mkdtempSync(join(tmpdir(), "astro-skbig-"));
  const big = SKILL_SCRIPTS.replace("Revise o diff e crie o commit.", `Revise o diff e crie o commit. ${"x".repeat(1_100_000)}`);
  skillDir(root, "giant", big);
  const warnings: string[] = [];
  const skills = loadSkillsFromRoot(root, "project", (message) => warnings.push(message));

  expect(skills).toEqual([]);
  expect(warnings.join("\n")).toMatch(/giant.*maior que/);
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
    const cfgPath = writeRunConfig(dir, up.port!, ["read_file", "run_command"]);
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

test("run dirigido por skill executa read_file e run_command no loop de tools", async () => {
  const seen: { messages: { role: string }[] }[] = [];
  let requests = 0;
  const up = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { messages: { role: string }[] };
      seen.push(body);
      requests += 1;
      if (requests === 1) {
        return Response.json({ choices: [{ message: { content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } },
          { id: "c2", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "echo run-ok" }) } },
        ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      return Response.json({ choices: [{ message: { content: "pronto" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-sktool-"));
    skillDir(join(dir, ".astro", "skills"), "commit", SKILL_SCRIPTS);
    writeFileSync(join(dir, "notes.txt"), "nota do diff");
    const cfgPath = writeRunConfig(dir, up.port!, ["read_file", "run_command"]);
    const report = await runTask({
      configPath: cfgPath, task: "/commit revisar o diff", cwd: dir,
      env: { KEY_A: "dummy" }, skillsUserRoot: join(dir, "sem-skills"),
    });

    expect(report.final).toBe("pronto");
    expect(requests).toBe(2);
    expect(seen[1]!.messages.map((message) => message.role)).toContain("tool");
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).toContain("skill.loaded");
    expect(audit).toContain("\"name\":\"read_file\"");
    expect(audit).toContain("\"name\":\"run_command\"");
    expect(audit).not.toContain("\"isError\":true");
  } finally {
    up.stop(true);
  }
});

test("run com skill pedindo tool fora da allowlist falha fechado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-skexec-deny-"));
  skillDir(join(dir, ".astro", "skills"), "deploy", SKILL.replace("name: commit", "name: deploy").replace("tools: [read_file, run_command]", "tools: [write_file]"));
  const cfgPath = writeRunConfig(dir, 1, ["read_file"]);
  await expect(runTask({
    configPath: cfgPath, task: "/deploy agora", cwd: dir,
    env: { KEY_A: "dummy" }, skillsUserRoot: join(dir, "sem-skills"),
  })).rejects.toThrow(/allowlist/);
  const auditText = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
  expect(auditText).toContain("run.started");
  expect(auditText).toContain("run.stopped");
  expect(auditText).not.toContain("skill.loaded");
});

test("loadSkillsFromRoot recusa skill com sha256 divergente do sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "astro-skhash-"));
  const dir = skillDir(root, "commit");
  writeFileSync(join(dir, ".sha256"), "0".repeat(64) + "\n", "utf8");
  const warnings: string[] = [];
  const skills = loadSkillsFromRoot(root, "project", (message) => warnings.push(message));

  expect(skills).toEqual([]);
  expect(warnings.join("\n")).toMatch(/commit.*sha256/);
});
