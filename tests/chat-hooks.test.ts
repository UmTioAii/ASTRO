import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { Auditor } from "../src/audit";
import type { ChatMessage } from "../src/provider/types";
import { Ledger } from "../src/ledger";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "astro-chat-hooks-"));
  const bodies: Array<{ model?: string; messages?: ChatMessage[] }> = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push((await req.json()) as { model?: string; messages?: ChatMessage[] });
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "p", id: "m2", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath, bodies, stop: () => server.stop(true) };
}

describe("hooks de chat no runTask (T1, #62)", () => {
  test("history vira contexto e o relatório devolve messages", async () => {
    const { cwd, configPath, bodies, stop } = setup();
    try {
      const history: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "anterior" },
        { role: "assistant", content: "resposta" },
      ];
      const report = await runTask({ configPath, task: "novo", cwd, env: { KEY: "k" }, history });
      expect(bodies[0]!.messages?.map((m) => m.content)).toEqual(["sys", "anterior", "resposta", "novo"]);
      expect(report.messages?.map((m) => m.content)).toEqual(["sys", "anterior", "resposta", "novo"]);
      expect(report.final).toBe("ok");
    } finally {
      stop();
    }
  });

  test("runId, model e suppressRunEvents são respeitados", async () => {
    const { cwd, configPath, bodies, stop } = setup();
    try {
      const report = await runTask({
        configPath, task: "x", cwd, env: { KEY: "k" },
        runId: "chat-run", model: "p/m2", suppressRunEvents: true,
        history: [{ role: "system", content: "sys" }],
      });
      expect(report.runId).toBe("chat-run");
      expect(report.model).toBe("p/m2");
      expect(bodies[0]!.model).toBe("m2");
      const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
      expect(audit.some((e) => e.tipo === "run.started" || e.tipo === "run.completed")).toBe(false);
      expect(audit.some((e) => e.tipo === "credential.acquired")).toBe(true);
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAll().filter((e) => e.run === "chat-run")).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
