import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";

/** Servidor mock: registra os models pedidos e responde `content` ou o status dado. */
function mockServer(status: number, content: string, seen: string[] = []) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model?: string };
      seen.push(body.model ?? "");
      return status === 200
        ? Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        : new Response(content, { status });
    },
  });
}

const provider = (baseUrl: string, credentialRef: string, extra: Record<string, unknown> = {}) => ({
  kind: "openai-compat",
  baseUrl,
  credentialRef,
  ...extra,
});
const model = (name: string, id: string) => ({ provider: name, id, tags: ["writing-code"], context: 4096 });

function writeConfig(dir: string, cfg: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({ ...cfg, paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" } }));
  return path;
}

const auditEvents = (dir: string) =>
  readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> });

test("agent nomeado sem profile mantém o model próprio (sem defaultProfile)", async () => {
  const seen: string[] = [];
  const server = mockServer(200, "ok", seen);
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31c-"));
    const cfgPath = writeConfig(dir, {
      providers: { mock: provider(`http://127.0.0.1:${server.port}/v1`, "TEST_KEY") },
      models: [model("mock", "m1"), model("mock", "m2"), model("mock", "m3")],
      // pro tem fallback de profile: garante que o roteador está montado.
      modelPool: { pro: { model: "mock/m2", fallback: ["other"] }, other: { model: "mock/m3" } },
      agents: { planner: { model: "mock/m1", maxSteps: 2, tools: [] } },
      agent: { profile: "pro", maxSteps: 2, tools: [] },
    });
    const report = await runTask({ approveSwap: () => true, configPath: cfgPath, task: "x", cwd: dir, env: { TEST_KEY: "test-key" } });
    expect(report.final).toBe("ok");
    expect(seen).toEqual(["m1"]); // worker não herda o profile do agent principal
  } finally {
    server.stop(true);
  }
});

test("credencial do primário ausente não impede o fallback de profile", async () => {
  const seen: string[] = [];
  const backup = mockServer(200, "do-b", seen);
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31c-"));
    const cfgPath = writeConfig(dir, {
      providers: {
        a: provider(`http://127.0.0.1:${backup.port}/v1`, "KEY_A"), // nunca chamado: credencial ausente
        b: provider(`http://127.0.0.1:${backup.port}/v1`, "KEY_B"),
      },
      models: [model("a", "m1"), model("b", "m2")],
      modelPool: { p1: { model: "a/m1", fallback: ["p2"] }, p2: { model: "b/m2" } },
      agent: { profile: "p1", maxSteps: 2, tools: [] },
    });
    const report = await runTask({ approveSwap: () => true, configPath: cfgPath, task: "x", cwd: dir, env: { KEY_B: "test-key" } });
    expect(report.final).toBe("do-b");
    expect(seen).toEqual(["m2"]); // criação preguiçosa: só o provider do profile destino foi instanciado
  } finally {
    backup.stop(true);
  }
});

test("fallback de provider dentro do profile carrega o profile no audit", async () => {
  const down = mockServer(503, "fora");
  const up = mockServer(200, "do-b");
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31c-"));
    const cfgPath = writeConfig(dir, {
      providers: {
        a: provider(`http://127.0.0.1:${down.port}/v1`, "KEY_A", { fallback: ["b"], maxRetries: 0, retryBackoffMs: 1 }),
        b: provider(`http://127.0.0.1:${up.port}/v1`, "KEY_B"),
      },
      models: [model("a", "m1"), model("b", "m1")],
      modelPool: { p1: { model: "a/m1" } },
      agent: { profile: "p1", maxSteps: 2, tools: [] },
    });
    const report = await runTask({ approveSwap: () => true,
      configPath: cfgPath,
      task: "x",
      cwd: dir,
      env: { KEY_A: "test-key", KEY_B: "test-key" },
    });
    expect(report.final).toBe("do-b");
    const events = auditEvents(dir);
    expect(events.find((e) => e.tipo === "provider.failure")!.payload).toMatchObject({ provider: "a", profile: "p1" });
    expect(events.find((e) => e.tipo === "provider.success")!.payload).toMatchObject({ provider: "b", profile: "p1" });
    const usage = readFileSync(join(dir, ".astro", "ledger.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { kind?: string; provider?: string })
      .find((e) => e.kind === undefined || e.kind === "usage");
    expect(usage?.provider).toBe("b");
    expect(readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8")).not.toContain("test-key"); // I-03
  } finally {
    down.stop(true);
    up.stop(true);
  }
});

test("profile sem fallback de provider herda o retry da F-01 e o audit por profile", async () => {
  const down = mockServer(502, "fora");
  const up = mockServer(200, "do-b");
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-f31c-"));
    const cfgPath = writeConfig(dir, {
      providers: {
        a: provider(`http://127.0.0.1:${down.port}/v1`, "KEY_A", { maxRetries: 1, retryBackoffMs: 1 }),
        b: provider(`http://127.0.0.1:${up.port}/v1`, "KEY_B"),
      },
      models: [model("a", "m1"), model("b", "m2")],
      modelPool: { p1: { model: "a/m1", fallback: ["p2"] }, p2: { model: "b/m2" } },
      agent: { profile: "p1", maxSteps: 2, tools: [] },
    });
    const report = await runTask({ approveSwap: () => true,
      configPath: cfgPath,
      task: "x",
      cwd: dir,
      env: { KEY_A: "test-key", KEY_B: "test-key" },
    });
    expect(report.final).toBe("do-b");
    const failures = auditEvents(dir).filter(
      (e) => e.tipo === "provider.failure" && e.payload.provider === "a",
    );
    expect(failures.map((e) => e.payload.attempt)).toEqual([1, 2]); // C6 embrulha a cadeia do profile
    expect(failures.every((e) => e.payload.profile === "p1")).toBe(true);
    expect(auditEvents(dir).some((e) => e.tipo === "profile.fallback")).toBe(true);
  } finally {
    down.stop(true);
    up.stop(true);
  }
});

test("provider primário da cadeia C6 é memoizado entre completions (F-31c)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-f31c-"));
  const pluginPath = join(dir, "count-plugin.ts");
  writeFileSync(pluginPath, `
export function definePlugin() {
  const g = globalThis;
  return { name: "count", tools: [], providers: [{ kind: "count", create() {
    g.__astroCreates = (g.__astroCreates ?? 0) + 1;
    return { async complete() {
      g.__astroCompletes = (g.__astroCompletes ?? 0) + 1;
      if (g.__astroCompletes === 1) return { content: "", toolCalls: [{ id: "c1", name: "list_dir", arguments: '{"path":"."}' }], usage: { inputTokens: 1, outputTokens: 1 } };
      return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }};
  }}]};
}`);
  const cfgPath = writeConfig(dir, {
    providers: {
      count: { kind: "count", fallback: ["b"] }, // cadeia C6 força o uso de create()
      b: provider("http://127.0.0.1:1/v1", "KEY_B"),
    },
    models: [model("count", "m1"), model("b", "m1")],
    agent: { model: "count/m1", maxSteps: 3, tools: ["list_dir"] },
    plugins: [pluginPath],
  });
  (globalThis as { __astroCreates?: number; __astroCompletes?: number }).__astroCreates = 0;
  (globalThis as { __astroCreates?: number; __astroCompletes?: number }).__astroCompletes = 0;
  const report = await runTask({ approveSwap: () => true, configPath: cfgPath, task: "x", cwd: dir, env: { KEY_B: "k" } });
  expect(report.final).toBe("ok");
  expect((globalThis as { __astroCreates?: number }).__astroCreates).toBe(1); // 2 steps, 1 provider
});
