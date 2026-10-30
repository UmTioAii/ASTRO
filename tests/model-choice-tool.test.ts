import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { resetCandidateSnapshots } from "../src/model-choice";

beforeEach(() => resetCandidateSnapshots());

describe("tool list_model_candidates no run (S-09)", () => {
  test("a tool é exposta pela allowlist e devolve o snapshot ao modelo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-candidates-tool-"));
    const bodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as { messages?: Array<{ role?: string; content?: string }> });
        calls++;
        if (calls === 1) {
          return Response.json({
            choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
              function: { name: "list_model_candidates", arguments: JSON.stringify({ need: "writing-code" }) } }] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
        }
        return Response.json({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" },
          backup: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "BACKUP_KEY" },
        },
        models: [
          { provider: "mock", id: "m1", tags: ["writing-code"], context: 8192 },
          { provider: "backup", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        ],
        modelPool: { fast: { model: "backup/m1" } },
        agent: { model: "mock/m1", maxSteps: 3, tools: ["list_model_candidates"] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });

      expect(report.final).toBe("done");
      const toolMessage = bodies[1]!.messages?.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("snapshot_id");
      expect(toolMessage?.content).toContain("candidates");
      expect(toolMessage?.content).toContain("backup/m1");
    } finally {
      server.stop(true);
    }
  });
});
