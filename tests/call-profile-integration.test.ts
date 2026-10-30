import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";

/** Servidor que captura o corpo e responde consoante o status. */
function server(status: number, bodies: Array<Record<string, unknown>>, capture = true) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      if (capture) bodies.push((await req.json()) as Record<string, unknown>);
      if (status >= 400) return Response.json({ error: { message: "boom" } }, { status });
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
}

describe("call profile na cadeia e no cache (E1/E3)", () => {
  test("fallback não herda o call do primário quando o destino não o declara", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-call-fallback-"));
    const primaryBodies: Array<Record<string, unknown>> = [];
    const backupBodies: Array<Record<string, unknown>> = [];
    const primary = server(400, primaryBodies);
    const backup = server(200, backupBodies);
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: {
          primary: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${primary.port}/v1`, credentialRef: "KEY", fallback: ["backup"], maxRetries: 0 },
          backup: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${backup.port}/v1`, credentialRef: "KEY" },
        },
        models: [{
          provider: "primary", id: "m1", tags: ["writing-code"], context: 8192,
          call: { thinking: { mode: "always", param: "thinking.type", on: "enabled" } },
        }],
        agent: { model: "primary/m1", maxSteps: 2, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" }, approveSwap: () => true });

      expect(report.final).toBe("ok");
      expect(primaryBodies).toHaveLength(1);
      expect(primaryBodies[0]!.thinking).toEqual({ type: "enabled" });
      expect(backupBodies).toHaveLength(1);
      expect(backupBodies[0]!.thinking).toBeUndefined();
    } finally {
      primary.stop(true);
      backup.stop(true);
    }
  });

  test("mudar o call do profile invalida o cache (escopo por request)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-call-cache-profile-"));
    const bodies: Array<Record<string, unknown>> = [];
    const mock = server(200, bodies);
    try {
      const configPath = join(cwd, "astro.config.json");
      const config = {
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${mock.port}/v1`, credentialRef: "KEY" } },
        models: [{
          provider: "mock", id: "prof", tags: ["writing-code"], context: 8192,
          call: { thinking: { mode: "always", param: "thinking.type", on: "enabled" } },
        }],
        modelPool: { fast: { model: "mock/prof" } },
        agent: { profile: "fast", maxSteps: 2, tools: [] },
        cache: { enabled: true, ttlHours: 24, maxEntries: 100 },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      };
      writeFileSync(configPath, JSON.stringify(config));

      await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.thinking).toEqual({ type: "enabled" });

      const changed = JSON.parse(readFileSync(configPath, "utf8")) as typeof config;
      changed.models[0]!.call!.thinking!.on = "disabled";
      writeFileSync(configPath, JSON.stringify(changed));

      await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(bodies).toHaveLength(2); // não serviu a entrada antiga
      expect(bodies[1]!.thinking).toEqual({ type: "disabled" });
    } finally {
      mock.stop(true);
    }
  });
});
