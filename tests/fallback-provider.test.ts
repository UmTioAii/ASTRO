import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { ConfigError, validateConfig, type PriceConfig } from "../src/config";
import { Registry } from "../src/registry";
import { Auditor } from "../src/audit";
import { FallbackProvider } from "../src/provider/fallback-provider";
import { ProviderError, type CompletionRequest, type CompletionResponse, type Provider } from "../src/provider/types";
import { runTask } from "../src/app";

const resp = (p: Partial<CompletionResponse> = {}): CompletionResponse => ({ content: "ok", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const req: CompletionRequest = { model: "m1", messages: [{ role: "user", content: "x" }], tools: [] };
const baseConfig = {
  providers: {
    a: { kind: "openai-compat", baseUrl: "http://a/v1", credentialRef: "KEY_A" },
    b: { kind: "openai-compat", baseUrl: "http://b/v1", credentialRef: "KEY_B" },
  },
  models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 4096 }],
  agent: { model: "a/m1", maxSteps: 2, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("config de providers avançada (C6)", () => {
  test("priority, fallback, maxRetries e retryBackoffMs válidos", () => {
    const raw = structuredClone(baseConfig);
    (raw.providers as Record<string, Record<string, unknown>>).a!.priority = 1;
    (raw.providers as Record<string, Record<string, unknown>>).a!.fallback = ["b"];
    (raw.providers as Record<string, Record<string, unknown>>).a!.maxRetries = 1;
    (raw.providers as Record<string, Record<string, unknown>>).a!.retryBackoffMs = 10;
    const cfg = validateConfig(raw);
    expect(cfg.providers.a!.priority).toBe(1);
    expect(cfg.providers.a!.fallback).toEqual(["b"]);
    expect(cfg.providers.a!.maxRetries).toBe(1);
    expect(cfg.providers.a!.retryBackoffMs).toBe(10);
    expect(cfg.providers.b!.priority).toBeUndefined(); // default aplicado no consumo
  });
  test("fallback apontando para provider inexistente → ConfigError", () => {
    const raw = structuredClone(baseConfig);
    (raw.providers as Record<string, Record<string, unknown>>).a!.fallback = ["ghost"];
    expect(() => validateConfig(raw)).toThrow(/ghost/);
  });
  test("priority, maxRetries e retryBackoffMs inválidos → ConfigError", () => {
    for (const [field, value] of [["priority", 0], ["maxRetries", -1], ["retryBackoffMs", 0]] as const) {
      const raw = structuredClone(baseConfig);
      (raw.providers as Record<string, Record<string, unknown>>).a![field] = value;
      const err = (() => { try { validateConfig(raw); } catch (e) { return e as ConfigError; } })();
      expect(err?.message).toContain("a");
    }
  });
  test("pricing global sobrescreve model.price no Registry", () => {
    const price: PriceConfig = { inputPerM: 3, outputPerM: 3, fonte: "curada", verificado: true };
    const cfg = validateConfig({ ...structuredClone(baseConfig), pricing: { "a/m1": price } });
    expect(new Registry(cfg).require("a/m1").price).toEqual(price);
  });
  test("pricing com chave de modelo inexistente → ConfigError", () => {
    const raw = { ...structuredClone(baseConfig), pricing: { "a/ghost": { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } } };
    expect(() => validateConfig(raw)).toThrow(/a\/ghost/);
  });
});

describe("FallbackProvider (C6)", () => {
  const auditOf = () => new Auditor(join(mkdtempSync(join(tmpdir(), "astro-c6-")), "audit.jsonl"));
  const counter = () => { const calls: string[] = []; return { calls, track: (name: string) => calls.push(name) }; };

  test("A em outage retrya e B responde: provider real e audit", async () => {
    const { calls, track } = counter();
    const a: Provider = { complete: async () => { track("a"); throw new ProviderError("outage", "a fora"); } };
    const b: Provider = { complete: async () => { track("b"); return resp(); } };
    const audit = auditOf();
    const fb = new FallbackProvider({ providers: [
      { name: "a", priority: 1, create: () => a }, { name: "b", priority: 2, create: () => b },
    ], maxRetries: 2, retryBackoffMs: 1, audit, run: "r1" });
    const out = await fb.complete(req);
    expect(out.provider).toBe("b"); // provider real, não o wrapper
    expect(out.content).toBe("ok");
    expect(calls.filter((c) => c === "a")).toHaveLength(3); // 1 + 2 retries (outage é retryable, D-14)
    const events = audit.readAll();
    expect(events.find((e) => e.tipo === "provider.failure")!.payload).toMatchObject({ provider: "a", errorClass: "outage" });
    expect(events.find((e) => e.tipo === "provider.success")!.payload).toMatchObject({ provider: "b" });
  });

  test("hard_quota não retrya: A uma vez, B responde", async () => {
    const { calls, track } = counter();
    const a: Provider = { complete: async () => { track("a"); throw new ProviderError("hard_quota", "cota"); } };
    const b: Provider = { complete: async () => { track("b"); return resp(); } };
    const fb = new FallbackProvider({ providers: [
      { name: "a", priority: 1, create: () => a }, { name: "b", priority: 2, create: () => b },
    ], maxRetries: 2, retryBackoffMs: 1, audit: auditOf(), run: "r1" });
    expect((await fb.complete(req)).provider).toBe("b");
    expect(calls.filter((c) => c === "a")).toHaveLength(1); // não retrya erro duro
  });

  test("cadeia esgotada lança o último erro com attempts registrados", async () => {
    const { calls, track } = counter();
    const a: Provider = { complete: async () => { track("a"); throw new ProviderError("hard_quota", "a"); } };
    const b: Provider = { complete: async () => { track("b"); throw new ProviderError("outage", "b fora"); } };
    const audit = auditOf();
    const fb = new FallbackProvider({ providers: [
      { name: "a", priority: 1, create: () => a }, { name: "b", priority: 2, create: () => b },
    ], maxRetries: 1, retryBackoffMs: 1, audit, run: "r1" });
    const err = await fb.complete(req).then(() => null, (e) => e as ProviderError);
    expect(err?.message).toContain("b fora");
    expect(calls.filter((c) => c === "b")).toHaveLength(2); // 1 + 1 retry
    expect(audit.readAll().filter((e) => e.tipo === "provider.failure")).toHaveLength(3);
  });

  test("ordem de prioridade decide quem atende primeiro", async () => {
    const { calls, track } = counter();
    const a: Provider = { complete: async () => { track("a"); return resp({ content: "de-a" }); } };
    const b: Provider = { complete: async () => { track("b"); return resp({ content: "de-b" }); } };
    const fb = new FallbackProvider({ providers: [
      { name: "a", priority: 9, create: () => a }, { name: "b", priority: 1, create: () => b },
    ], maxRetries: 1, retryBackoffMs: 1, audit: auditOf(), run: "r1" });
    expect((await fb.complete(req)).provider).toBe("b"); // prioridade menor primeiro
    expect(calls).toEqual(["b"]);
  });

  test("falha na fábrica de um fallback pula para o próximo da cadeia com evento de audit", async () => {
    const a: Provider = { complete: async () => { throw new ProviderError("outage", "a fora"); } };
    let bCreated = 0;
    const c: Provider = { complete: async () => resp({ content: "de-c" }) };
    const audit = auditOf();
    const fb = new FallbackProvider({ providers: [
      { name: "a", priority: 1, create: () => a },
      { name: "b", priority: 2, create: () => { bCreated++; throw new Error("defina KEY_B no ambiente"); } },
      { name: "c", priority: 3, create: () => c },
    ], maxRetries: 1, retryBackoffMs: 1, audit, run: "r1" });
    const out = await fb.complete(req);
    expect(out.provider).toBe("c"); // c saudável atende apesar da fábrica de b quebrar
    expect(out.content).toBe("de-c");
    expect(bCreated).toBe(1); // fábrica chamada uma vez, sem retry de fábrica
    const failures = audit.readAll().filter((e) => e.tipo === "provider.failure");
    expect(failures.map((e) => (e.payload as { provider: string }).provider)).toEqual(["a", "a", "b"]);
    expect(failures.at(-1)!.payload).toMatchObject({ provider: "b", errorClass: "invalid_request" });
    expect(audit.readAll().some((e) => e.tipo === "provider.success")).toBe(true);
  });

  test("maxRetries fracionário → ConfigError", () => {
    const raw = structuredClone(baseConfig);
    (raw.providers as Record<string, Record<string, unknown>>).a!.maxRetries = 1.5;
    expect(() => validateConfig(raw)).toThrow(/maxRetries/);
  });

  test("integração: A falha, B responde sem intervenção e o ledger registra o provider real", async () => {
    const down = Bun.serve({
      port: 0,
      fetch: async () => new Response("boom", { status: 500 }),
    });
    const up = Bun.serve({
      port: 0,
      fetch: async (r) => {
        if (r.headers.get("authorization") !== "Bearer test-key") return new Response("no auth", { status: 401 });
        return Response.json({ choices: [{ message: { content: "veio do B" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-c6-app-"));
      const cfgPath = join(dir, "astro.config.json");
      writeFileSync(cfgPath, JSON.stringify({
        providers: {
          mocka: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${down.port}/v1`, credentialRef: "KEY_A", priority: 1, fallback: ["mockb"], maxRetries: 1, retryBackoffMs: 1 },
          mockb: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${up.port}/v1`, credentialRef: "KEY_B", priority: 2 },
        },
        models: [
          { provider: "mocka", id: "m1", tags: ["writing-code"], context: 4096 },
          { provider: "mockb", id: "m1", tags: ["writing-code"], context: 4096 },
        ],
        agent: { model: "mocka/m1", maxSteps: 2, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: { KEY_A: "test-key", KEY_B: "test-key" } });
      expect(report.final).toBe("veio do B");
      const usage = JSON.parse(readFileSync(join(dir, ".astro", "ledger.jsonl"), "utf8").split("\n")[0]!);
      expect(usage.provider).toBe("mockb"); // provider real, não o wrapper nem o primário
      const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
      expect(audit).toContain("provider.failure");
      expect(audit).toContain("provider.success");
      expect(audit).not.toContain("test-key"); // I-03
    } finally {
      down.stop(true); up.stop(true);
    }
  });

  test("fallback: [] desabilita — falha do primário derruba o run (comportamento atual)", async () => {
    const down = Bun.serve({ port: 0, fetch: async () => new Response("boom", { status: 500 }) });
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-c6-off-"));
      const cfgPath = join(dir, "astro.config.json");
      writeFileSync(cfgPath, JSON.stringify({
        providers: { mocka: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${down.port}/v1`, credentialRef: "KEY_A", fallback: [] } },
        models: [{ provider: "mocka", id: "m1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "mocka/m1", maxSteps: 2, tools: [] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const err = await runTask({ configPath: cfgPath, task: "x", cwd: dir, env: { KEY_A: "test-key" } }).then(() => null, (e) => e as Error);
      expect(String(err?.message)).toContain("500");
      expect(readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8")).not.toContain("provider.success");
    } finally {
      down.stop(true);
    }
  });

  test("profile no FallbackProvider atribui os eventos ao profile (F-31)", async () => {
    const a: Provider = { complete: async () => { throw new ProviderError("outage", "a fora"); } };
    const b: Provider = { complete: async () => resp() };
    const audit = auditOf();
    const fb = new FallbackProvider({
      providers: [
        { name: "a", priority: 1, create: () => a },
        { name: "b", priority: 2, create: () => b },
      ],
      maxRetries: 1,
      retryBackoffMs: 1,
      audit,
      run: "r1",
      profile: "premium",
    });
    await fb.complete(req);
    for (const tipo of ["provider.failure", "provider.success"] as const) {
      expect(audit.readAll().find((e) => e.tipo === tipo)!.payload).toMatchObject({ profile: "premium" });
    }
  });
});
