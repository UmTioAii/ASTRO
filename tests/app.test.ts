import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";

async function withMockProvider(handler: (call: number) => unknown, fn: (baseUrl: string) => Promise<void>) {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== "Bearer test-key") return new Response("no auth", { status: 401 });
      call++;
      return Response.json(handler(call));
    },
  });
  try {
    await fn(`http://127.0.0.1:${server.port}/v1`);
  } finally {
    server.stop(true);
  }
}

function writeConfig(dir: string, baseUrl: string): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096, price: { inputPerM: 1, outputPerM: 1, fonte: "teste", verificado: false } }],
    agent: { model: "mock/mock-1", maxSteps: 6, tools: ["write_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return path;
}

test("happy path: tarefa com tool roda ponta a ponta", async () => {
  await withMockProvider(
    (call) => call === 1
      ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "oi" }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      : { choices: [{ message: { content: "criei hello.txt" } }], usage: { prompt_tokens: 20, completion_tokens: 8 } },
    async (baseUrl) => {
      const dir = mkdtempSync(join(tmpdir(), "astro-app-"));
      const report = await runTask({ configPath: writeConfig(dir, baseUrl), task: "crie hello.txt", cwd: dir, env: { TEST_KEY: "test-key" } });
      expect(report.final).toBe("criei hello.txt");
      expect(report.tokensIn).toBe(30);
      expect(report.costUsd).toBeCloseTo(30 / 1e6 + 13 / 1e6, 10);
      expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("oi");
      const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
      expect(audit).toContain("run.started");
      expect(audit).toContain("credential.acquired");
      expect(audit).toContain("tool.call");
      expect(audit).toContain("run.completed");
      expect(audit).not.toContain("test-key");
    },
  );
});

test("chave ausente → mensagem clara e sem valor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-app-"));
  const err = (await runTask({ configPath: writeConfig(dir, "http://127.0.0.1:1/v1"), task: "x", cwd: dir, env: {} }).catch((e) => e as Error)) as Error;
  expect(String(err.message)).toContain("TEST_KEY");
});

test("tool desconhecida na config → erro claro", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-app-"));
  const cfgPath = writeConfig(dir, "http://127.0.0.1:1/v1");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.agent.tools = ["ghost"];
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const err = (await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: { TEST_KEY: "k" } }).catch((e) => e as Error)) as Error;
  expect(String(err.message)).toContain("ghost");
});

test("agent com profile: startup resolve o modelo da pool (F-29)", async () => {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model?: string };
      requested.push(body.model ?? "");
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-app-"));
    const cfgPath = join(dir, "astro.config.json");
    writeFileSync(cfgPath, JSON.stringify({
      providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
      models: [
        { provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 },
        { provider: "mock", id: "mock-2", tags: ["writing-code"], context: 4096 },
      ],
      modelPool: { pro: { model: "mock/mock-2" } },
      agent: { profile: "pro", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    }));
    const report = await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: { TEST_KEY: "test-key" } });
    expect(report.final).toBe("ok");
    expect(requested).toEqual(["mock-2"]); // profile substitui o model direto no startup
  } finally {
    server.stop(true);
  }
});
