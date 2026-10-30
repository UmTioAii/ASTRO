import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { Ledger } from "../src/ledger";

const REASONING = "texto de raciocínio que não pode ser persistido";

describe("call profile ponta a ponta (E1–E8)", () => {
  test("config do modelo chega ao provider e o usage grava lvl/effort/thinking sem raciocínio", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-call-e2e-"));
    let body: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = (await req.json()) as Record<string, unknown>;
        return Response.json({
          choices: [{ message: { content: "ok", reasoning_content: REASONING } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{
          provider: "mock", id: "m1", tags: ["writing-code"], context: 8192,
          call: {
            effort: { param: "reasoning.effort", map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "ultra" } },
            thinking: { mode: "toggle", param: "thinking.type", on: "enabled", off: "disabled" },
            forbidden: ["temperature"],
          },
        }],
        agent: { model: "mock/m1", maxSteps: 2, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      const report = await runTask({
        configPath, task: "x", cwd, env: { KEY: "k" }, call: { lvl: 3, thinking: "off" },
      });
      expect(report.final).toBe("ok");
      expect(body).toMatchObject({ reasoning: { effort: "high" }, thinking: { type: "disabled" } });

      const ledgerPath = join(cwd, ".astro", "ledger.jsonl");
      const usage = new Ledger(ledgerPath).readAllEntries().find((e) => e.kind === "usage");
      expect(usage).toMatchObject({ lvl: 3, effort: "high", thinking: "disabled" });
      expect(readFileSync(ledgerPath, "utf8")).not.toContain(REASONING);
      expect(readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8")).not.toContain(REASONING);
    } finally {
      server.stop(true);
    }
  });
});
