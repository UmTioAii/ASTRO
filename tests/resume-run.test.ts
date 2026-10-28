import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { Ledger } from "../src/ledger";
import { rebuildAgentTree } from "../src/resume";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Config com agents planner/coder e servidor HTTP que registra os modelos chamados. */
function setup(coderModel = "m2") {
  const cwd = mkdtempSync(join(tmpdir(), "astro-resume-run-"));
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string };
      seen.push(body.model ?? "");
      return Response.json({ choices: [{ message: { content: "retomado ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    },
  });
  const config = {
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
    models: [
      { provider: "mock", id: "m1", tags: ["writing-code"], context: 8192, price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
      { provider: "mock", id: coderModel, tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "mock/m1", maxSteps: 2, tools: [] },
    agents: {
      planner: { model: "mock/m1", maxSteps: 2, tools: [] },
      coder: { model: `mock/${coderModel}`, maxSteps: 2, tools: [] },
    },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { cwd, configPath, seen, server };
}

/** Semeia run interrompido com planner já destruído (handoff) e coder ativo. */
function seedInterrupted(cwd: string, run = "r1", coderModel = "m2"): Ledger {
  mkdirSync(join(cwd, ".astro"), { recursive: true });
  const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
  ledger.recordAgentCreated({ run, agent_id: "planner", session_id: run, model: "m1" });
  ledger.recordAgentDestroyed({ run, agent_id: "planner", session_id: run, reason: "handoff" });
  ledger.recordAgentCreated({ run, agent_id: "coder", parent_agent_id: "planner", session_id: run, model: coderModel });
  ledger.recordState(run, "interrupted", { agent: "coder", reason: "cancelled" });
  return ledger;
}

describe("execução de resume (F-22, #131)", () => {
  test("retoma no agente ativo, com o modelo gravado, no mesmo run", async () => {
    const { cwd, configPath, seen, server } = setup();
    try {
      const ledger = seedInterrupted(cwd);
      const report = await runTask({ configPath, task: "continue", cwd, env: { TEST_KEY: "x" }, resume: "r1" });

      expect(report.runId).toBe("r1");
      expect(report.resumedFrom).toBe("coder");
      expect(seen).toEqual(["m2"]); // não reexecuta o planner (m1)
      const tree = rebuildAgentTree(ledger, "r1");
      expect(tree.nodes.at(-1)).toMatchObject({ agent_id: "coder", model: "m2", reason: "completed" });
      expect(tree.active).toBeUndefined();
      expect(report.model).toBe("mock/m2");
      expect(report.costUsd).toBeNull(); // m2 não tem preço; m1 (base) tem
      const started = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll().find((e) => e.tipo === "run.started");
      expect((started!.payload as { model?: string }).model).toBe("mock/m2");
      expect(ledger.readAll().filter((e) => e.run === "r1")).toHaveLength(1); // uma chamada, sem reexecutar planner
      expect(ledger.byAgent().coder?.tokensIn).toBe(10);
    } finally {
      server.stop(true);
    }
  });

  test("single-agent interrompido retoma no 'default' com o modelo gravado", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-resume-single-"));
    const seen: string[] = [];
    let call = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const body = (await req.json()) as { model?: string };
      seen.push(body.model ?? "");
      call++;
      return call === 1
        ? new Response("boom", { status: 400 })
        : Response.json({ choices: [{ message: { content: "continuou" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "mock/m1", maxSteps: 2, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      await expect(runTask({ configPath, task: "x", cwd, env: { TEST_KEY: "x" } })).rejects.toThrow(/provider/);

      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      const runId = ledger.readStates()[0]!.run;
      const report = await runTask({ configPath, task: "x", cwd, env: { TEST_KEY: "x" }, resume: runId });
      expect(report.resumedFrom).toBe("default");
      expect(report.model).toBe("mock/m1");
      expect(seen).toEqual(["m1", "m1"]);
      expect(rebuildAgentTree(ledger, runId).nodes[0]!.reason).toBe("completed");
    } finally {
      server.stop(true);
    }
  });

  test("modelo ausente no evento → replay_incomplete sem chamar provider", async () => {
    const { cwd, configPath, seen, server } = setup();
    try {
      mkdirSync(join(cwd, ".astro"), { recursive: true });
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      ledger.recordAgentCreated({ run: "r1", agent_id: "coder", session_id: "r1" }); // sem model
      ledger.recordState("r1", "interrupted", { agent: "coder", reason: "cancelled" });
      await expect(runTask({ configPath, task: "x", cwd, env: { TEST_KEY: "x" }, resume: "r1" })).rejects.toThrow(/sem modelo gravado/);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("run concluído não é retomado e não chama provider", async () => {
    const { cwd, configPath, seen, server } = setup();
    try {
      const ledger = seedInterrupted(cwd);
      ledger.recordAgentDestroyed({ run: "r1", agent_id: "coder", session_id: "r1", reason: "completed" });
      ledger.recordState("r1", "completed", { agent: "coder" });
      await expect(runTask({ configPath, task: "x", cwd, env: { TEST_KEY: "x" }, resume: "r1" })).rejects.toThrow(/já concluído/);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("drift de modelo na config → replay_incomplete sem chamar provider", async () => {
    const { cwd, configPath, seen, server } = setup("m2");
    try {
      seedInterrupted(cwd, "r1", "m-old");
      await expect(runTask({ configPath, task: "x", cwd, env: { TEST_KEY: "x" }, resume: "r1" })).rejects.toThrow(/modelo do agente "coder" mudou/);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("bun src/cli.ts resume retoma o run e imprime o agente", async () => {
    const { cwd, configPath, seen, server } = setup();
    try {
      seedInterrupted(cwd);
      const proc = Bun.spawn(["bun", "src/cli.ts", "resume", "r1", "--task", "continue", "--config", configPath, "--cwd", cwd], {
        cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, TEST_KEY: "x" },
      });
      const exit = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exit).toBe(0);
      expect(stdout).toContain("retomado coder do run r1");
      expect(stdout).toContain("retomado ok");
      expect(seen).toEqual(["m2"]);

      const dup = Bun.spawn(["bun", "src/cli.ts", "resume", "r1", "--task", "a", "--task", "b", "--config", configPath, "--cwd", cwd], {
        cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, TEST_KEY: "x" },
      });
      expect(await dup.exited).toBe(1);
      expect(await new Response(dup.stderr).text()).toContain("--task duplicado");
    } finally {
      server.stop(true);
    }
  });
});
