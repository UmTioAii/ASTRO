import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { findRunMetrics, replayRun } from "../src/replay";

function writeConfig(dir: string, baseUrl: string): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096, price: { inputPerM: 1, outputPerM: 1, fonte: "teste", verificado: true } }],
    agent: { model: "mock/mock-1", maxSteps: 6, tools: ["write_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return path;
}

/** Servidor mock determinístico: call ímpar = tool call; call par = resposta final. */
function mockServer() {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== "Bearer test-key") {
        return new Response("no auth", { status: 401 });
      }
      const calls = Number(req.headers.get("x-call") ?? "0"); // não usado; contagem via body
      void calls;
      // determinístico por conteúdo: com tool_calls sempre, depois final
      const body = JSON.parse(await req.text()) as { messages: Array<{ role: string }> };
      const hasToolMessage = body.messages.some((m) => m.role === "tool");
      if (hasToolMessage) {
        return Response.json({ choices: [{ message: { content: "replay: concluído" } }], usage: { prompt_tokens: 20, completion_tokens: 8 } });
      }
      return Response.json({
        choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "oi" }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

async function runOnce(dir: string, baseUrl: string) {
  return runTask({ configPath: writeConfig(dir, baseUrl), task: "crie hello.txt", cwd: dir, env: { TEST_KEY: "test-key" } });
}

describe("replay (F6-5)", () => {
  test("findRunMetrics extrai métricas do run.completed; run inexistente → null", async () => {
    const mock = mockServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-replay-"));
      const report = await runOnce(dir, mock.baseUrl);
      const auditPath = join(dir, ".astro", "audit.jsonl");

      const metrics = findRunMetrics(auditPath, report.runId);
      expect(metrics).not.toBeNull();
      expect(metrics!.steps).toBe(report.steps);
      expect(metrics!.tokensIn).toBe(report.tokensIn);
      expect(metrics!.tokensOut).toBe(report.tokensOut);

      expect(findRunMetrics(auditPath, "run-fantasma")).toBeNull();
    } finally {
      mock.stop();
    }
  });

  test("replay com provider determinístico reproduz métricas idênticas", async () => {
    const mock = mockServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-replay-"));
      const original = await runOnce(dir, mock.baseUrl);
      expect(original.runId).toBeTruthy();

      const result = await replayRun({
        configPath: join(dir, "astro.config.json"),
        auditPath: join(dir, ".astro", "audit.jsonl"),
        runId: original.runId,
        task: "crie hello.txt",
        cwd: dir,
        env: { TEST_KEY: "test-key" },
      });

      expect(result.original.steps).toBe(original.steps);
      expect(result.replay.steps).toBe(original.steps);
      expect(result.replay.tokensIn).toBe(original.tokensIn);
      expect(result.replay.tokensOut).toBe(original.tokensOut);
      expect(result.replay.costUsd).not.toBeNull();
      expect(Math.abs(result.replay.costUsd! - original.costUsd!)).toBeLessThan(1e-9);
      expect(result.replay.final).toBe(original.final);
      expect(result.identical).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("replay divergente marca identical=false", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        calls++;
        const body = JSON.parse(await req.text()) as { messages: Array<{ role: string }> };
        const hasToolMessage = body.messages.some((m) => m.role === "tool");
        if (hasToolMessage) {
          // segunda execução devolve tokens diferentes → divergência
          const tokens = calls <= 2 ? { prompt_tokens: 20, completion_tokens: 8 } : { prompt_tokens: 99, completion_tokens: 9 };
          return Response.json({ choices: [{ message: { content: "final" } }], usage: tokens });
        }
        return Response.json({
          choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "y" }) } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-replay-"));
      const baseUrl = `http://127.0.0.1:${server.port}/v1`;
      const original = await runOnce(dir, baseUrl);
      const result = await replayRun({
        configPath: join(dir, "astro.config.json"),
        auditPath: join(dir, ".astro", "audit.jsonl"),
        runId: original.runId,
        task: "crie hello.txt",
        cwd: dir,
        env: { TEST_KEY: "test-key" },
      });
      expect(result.identical).toBe(false);
      expect(result.replay.tokensIn).not.toBe(original.tokensIn);
    } finally {
      server.stop(true);
    }
  });

  test("run inexistente → erro claro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-replay-"));
    const err = await replayRun({
      configPath: writeConfig(dir, "http://127.0.0.1:1/v1"),
      auditPath: join(dir, ".astro", "audit.jsonl"),
      runId: "fantasma",
      task: "x",
      cwd: dir,
      env: { TEST_KEY: "k" },
    }).then(() => null, (e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("fantasma");
    expect(err!.message).toContain("não encontrado");
  });
});