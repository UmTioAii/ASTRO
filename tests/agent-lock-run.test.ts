import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { Ledger } from "../src/ledger";

/** Config de agente único com servidor sintético; `maxSteps` controla o corte. */
function setup(finalOnCall: number, maxSteps = 1) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-lock-run-"));
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls++;
      return calls >= finalOnCall
        ? Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        : Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: `c${calls}`, type: "function",
          function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "mock/m1", maxSteps, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath, server, calls: () => calls };
}

describe("run que falha devolve a conta (A4, I-19)", () => {
  test("MaxSteps no single-agent não bloqueia o run seguinte", async () => {
    const { cwd, configPath, server } = setup(2);
    try {
      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toThrow(/excedeu 1 passos/);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().filter((e) => e.kind === "agent" && e.event === "destroyed")).toHaveLength(1);
      expect(ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "destroyed")).toMatchObject({ reason: "max_steps" });

      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(report.final).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("MaxSteps no multi-agent também libera o lock do agente corrente", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-lock-multi-"));
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        calls++;
        return calls >= 2
          ? Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
          : Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
            function: { name: "ghost", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
          backup: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "BACKUP_KEY" },
        },
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "mock/m1", maxSteps: 1, tools: [] },
        agents: {
          planner: { model: "mock/m1", maxSteps: 1, tools: [] },
          coder: { model: "mock/m1", maxSteps: 1, tools: [] },
        },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      await expect(runTask({ configPath, task: "x", cwd, env: { KEY: "k" } })).rejects.toThrow(/excedeu/);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "destroyed")).toMatchObject({
        agent_id: "planner",
        reason: "max_steps",
      });

      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(report.final).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("crash duro (agent.created de PID morto) não cativa a conta no próximo run", async () => {
    const { cwd, configPath, server } = setup(1);
    try {
      // PID de um processo que já terminou: prova de morte, não suposição.
      const child = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
      await child.exited;
      const deadPid = child.pid;

      const ledgerPath = join(cwd, ".astro", "ledger.jsonl");
      const ledger = new Ledger(ledgerPath);
      ledger.recordAgentCreated({ run: "crashed", agent_id: "default", session_id: "crashed", model: "m1", pid: deadPid });

      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });

      expect(report.final).toBe("ok");
      const recovered = ledger.readAllEntries().find(
        (e) => e.kind === "agent" && e.run === "crashed" && e.event === "destroyed",
      );
      expect(recovered).toMatchObject({ agent_id: "default", reason: "crash_recovered" });
    } finally {
      server.stop(true);
    }
  });
});
