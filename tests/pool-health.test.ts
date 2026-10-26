import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/config";
import { runPoolHealthCheck } from "../src/health";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const base = (): Record<string, unknown> => ({
  providers: {
    a: { kind: "openai-compat", baseUrl: "http://a/v1", credentialRef: "KEY_A" },
    b: { kind: "openai-compat", baseUrl: "http://b/v1", credentialRef: "KEY_B" },
  },
  models: [
    { provider: "a", id: "m1", tags: ["writing-code"], context: 4096 },
    { provider: "b", id: "m1", tags: ["writing-code"], context: 4096 },
  ],
  modelPool: {
    primary: { model: "a/m1", fallback: ["backup"] },
    backup: { model: "b/m1" },
  },
  agent: { profile: "primary", maxSteps: 2, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});

const cfg = (over: Record<string, unknown> = {}) => validateConfig({ ...base(), ...over });
const env = { KEY_A: "k", KEY_B: "k" };
/** a fora, b ok: a decide por URL. */
const fetchA = (status: number) =>
  (async (url: string) => new Response("{}", { status: String(url).includes("a/v1") ? status : 200 })) as unknown as typeof fetch;
/** Derrota qualquer provider: usado para a cadeia inteira fora. */
const fetchAll = (status: number) =>
  (async () => new Response("{}", { status })) as unknown as typeof fetch;

describe("pool health por profile (F-31)", () => {
  test("primário fora com fallback saudável → profile degraded; fallback ok; agregado degraded", async () => {
    const report = await runPoolHealthCheck(cfg(), env, { fetchLike: fetchA(500) });
    const primary = report.profiles.find((p) => p.name === "primary")!;
    const backup = report.profiles.find((p) => p.name === "backup")!;
    expect(primary).toMatchObject({ model: "a/m1", provider: "a", fallback: ["backup"], status: "degraded" });
    expect(primary.detail).toContain("backup");
    expect(backup.status).toBe("ok");
    expect(report.status).toBe("degraded");
    expect(report.providers.checks.some((c) => c.name === "provider:a" && c.status === "down")).toBe(true);
  });

  test("todos os providers ok → todos os profiles ok e agregado ok", async () => {
    const report = await runPoolHealthCheck(cfg(), env, { fetchLike: fetchA(200) });
    expect(report.profiles.map((p) => p.status)).toEqual(["ok", "ok"]);
    expect(report.status).toBe("ok");
  });

  test("cadeia inteira fora → profile down e agregado down", async () => {
    const report = await runPoolHealthCheck(cfg(), env, { fetchLike: fetchAll(500) });
    expect(report.profiles.every((p) => p.status === "down")).toBe(true);
    expect(report.status).toBe("down");
  });

  test("sem modelPool: nenhum profile, status vem dos providers", async () => {
    const noPool = cfg({ modelPool: undefined, agent: { model: "a/m1", maxSteps: 2, tools: [] } });
    const report = await runPoolHealthCheck(noPool, env, { fetchLike: fetchA(200) });
    expect(report.profiles).toEqual([]);
    expect(report.status).toBe("ok");
  });

  test("bun src/cli.ts pool health imprime os profiles e sai 1 quando down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-pool-health-"));
    const cfgPath = join(dir, "astro.config.json");
    writeFileSync(cfgPath, JSON.stringify({
      ...base(),
      providers: {
        a: { kind: "openai-compat", baseUrl: "http://a/v1", credentialRef: "ASTRO_F31_MISSING_A" },
        b: { kind: "openai-compat", baseUrl: "http://b/v1", credentialRef: "ASTRO_F31_MISSING_B" },
      },
    }), "utf8");
    const proc = Bun.spawn(["bun", "src/cli.ts", "pool", "health", "--config", cfgPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(exit).toBe(1);
    expect(out).toContain('"profiles"');
    expect(out).toContain('"name": "primary"');
    expect(out).toContain('"status": "down"');
  });
});
