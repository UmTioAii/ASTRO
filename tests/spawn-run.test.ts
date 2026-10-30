import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeLocks } from "../src/agent-lock";
import { runTask } from "../src/app";
import { Ledger } from "../src/ledger";
import { rebuildAgentTree } from "../src/resume";

interface Body {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
}

describe("spawn_agent ponta a ponta (S-11, C4a)", () => {
  test("orchestrator spawna, faz handoff e o filho conclui sem herdar histórico", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-spawn-run-"));
    const bodies: Body[] = [];
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Body);
        calls++;
        const tool = (name: string, args: object) => ({
          choices: [{ message: { content: "", tool_calls: [{ id: `c${calls}`, type: "function",
            function: { name, arguments: JSON.stringify(args) } }] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
        if (calls === 1) return Response.json(tool("spawn_agent", { need: "writing-code", task: "sub tarefa", tools: [] }));
        if (calls === 2) {
          return Response.json(tool("handoff", {
            to: "sub-1", task: "sub tarefa", objective: "resolver", decisions: [], constraints: [], next_steps: [],
          }));
        }
        return Response.json({ choices: [{ message: { content: "sub done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(join(cwd, "AGENTS.md"), "Regras do projeto para o subagente");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          p1: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY1" },
          p2: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY2" },
        },
        models: [
          { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
          { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        ],
        modelPool: { fast: { model: "p1/m1" }, smart: { model: "p2/m2" } },
        agent: { model: "p1/m1", maxSteps: 4, tools: ["spawn_agent", "handoff"] },
        agents: { planner: { profile: "fast", maxSteps: 4, tools: ["spawn_agent", "handoff"] } },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      const report = await runTask({
        configPath, task: "tarefa do orchestrator", cwd, env: { KEY1: "1", KEY2: "2" }, approveSwap: () => true,
      });

      expect(report.final).toBe("sub done");
      expect(calls).toBe(3);

      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      const tree = rebuildAgentTree(ledger, report.runId);
      expect(tree.nodes.map((node) => node.agent_id)).toEqual(["planner", "sub-1"]);
      expect(tree.nodes[1]).toMatchObject({ parent_agent_id: "planner", reason: "completed" });
      expect(activeLocks(ledger)).toEqual([]);

      // O filho recebe system + artefato, nunca o histórico do orchestrator.
      const child = bodies[2]!;
      expect(child.messages?.some((message) => message.role === "assistant")).toBe(false);
      expect(child.messages?.some((message) => message.content?.includes("spawn_agent"))).toBe(false);
      expect(child.messages?.some((message) => message.content?.includes("Regras do projeto"))).toBe(true);
      expect(child.messages?.some((message) => message.content?.includes("sub tarefa"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
