import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { definePlugin, loadPlugins, pluginAllowlistFromEnv } from "../src/plugins";
import { runTask } from "../src/app";

/** Plugin de teste: tool sql_query + provider factory bigquery. */
const PLUGIN_SOURCE = `
export function definePlugin() {
  return {
    name: "test-plugin",
    tools: [
      {
        manifest: {
          name: "sql_query",
          description: "Executa uma consulta SQL no banco de teste.",
          parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
          risk: "high", permission: "execute", timeoutMs: 5000, retryable: false,
          idempotent: false, sideEffects: "process",
        },
        async execute(input) {
          const sql = input.sql ?? "";
          return { output: \`resultado da consulta: \${sql}\` };
        },
      },
    ],
    providers: [
      {
        kind: "bigquery",
        create(rawConfig, env) {
          return {
            async complete(req) {
              return {
                content: "resposta do bigquery: " + (env.BQ_STUB ?? "sem-stub"),
                toolCalls: [],
                usage: { inputTokens: 7, outputTokens: 3 },
              };
            },
          };
        },
      },
    ],
  };
}
`;

function writePlugin(dir: string): string {
  const path = join(dir, "test-plugin.ts");
  writeFileSync(path, PLUGIN_SOURCE, "utf8");
  return path;
}

function writeConfig(dir: string, plugins: string[], providers: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers,
    models: [{ provider: "bq", id: "model-x", tags: ["writing-code"], context: 4096 }],
    agent: { model: "bq/model-x", maxSteps: 3, tools: ["sql_query"] },
    plugins,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));
  return path;
}

describe("plugin system (F7-1)", () => {
  test("definePlugin é identidade para DX", () => {
    const def = definePlugin({ name: "x", tools: [], providers: [] });
    expect(def.name).toBe("x");
  });

  test("loadPlugins carrega tool e provider factory de arquivo .ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const loaded = await loadPlugins([writePlugin(dir)]);
    expect(loaded.tools).toHaveLength(1);
    expect(loaded.tools[0]!.manifest.name).toBe("sql_query");
    expect(loaded.providerFactories.size).toBe(1);
    expect(loaded.providerFactories.has("bigquery")).toBe(true);
  });

  test("plugin com path inexistente: warn isolado, segue sem ele", async () => {
    const warnings: string[] = [];
    const loaded = await loadPlugins(["./plugin-fantasma.ts"], { warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(0);
    expect(loaded.providerFactories.size).toBe(0);
    expect(warnings.some((w) => w.includes("plugin-fantasma"))).toBe(true);
  });

  test("módulo sem definePlugin válido: warn e ignorado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const bad = join(dir, "bad-plugin.ts");
    writeFileSync(bad, "export const outra = 1;\n", "utf8");
    const warnings: string[] = [];
    const loaded = await loadPlugins([bad], { warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(0);
    expect(warnings.some((w) => w.includes("não exporta"))).toBe(true);
  });

  test("runTask ponta a ponta com plugin: tool sql_query e provider bigquery sem tocar o core", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const configPath = writeConfig(dir, [writePlugin(dir)], {
      bq: { kind: "bigquery", credentialRef: "BQ_KEY", dataset: "meu" },
    });

    const report = await runTask({ configPath, task: "consulte o banco", cwd: dir, env: { BQ_KEY: "k", BQ_STUB: "stub-ok" } });
    // provider do plugin respondeu
    expect(report.final).toContain("resposta do bigquery: stub-ok");
    expect(report.tokensIn).toBe(7);
    expect(report.tokensOut).toBe(3);

    // a tool do plugin foi validada na config (não rejeitada como desconhecida)
    // e o run passou pelo fluxo normal com ledger/audit
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).toContain("run.started");
    expect(audit).toContain("run.completed");
  });

  test("kind de plugin sem factory registrada → erro claro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const configPath = writeConfig(dir, [], { bq: { kind: "bigquery" } });
    const err = (await runTask({ configPath, task: "x", cwd: dir, env: {} }).then(() => null, (e) => e)) as Error;
    expect(String(err!.message)).toContain("sem factory");
  });

  test("config com plugins inválidos → ConfigError", () => {
    expect(() =>
      validateConfig({
        providers: { openai: { kind: "openai-compat", baseUrl: "http://x", credentialRef: "K" } },
        models: [{ provider: "openai", id: "m", tags: ["fast"], context: 1 }],
        agent: { model: "openai/m", maxSteps: 1, tools: [] },
        plugins: [""],
        paths: { ledger: "l", audit: "a" },
      }),
    ).toThrow();
  });
});

describe("plugin trust (I-13, #255)", () => {
  test("pacote remoto fora da allowlist falha fechado, com warn", async () => {
    const warnings: string[] = [];
    const loaded = await loadPlugins(["dark-plugin"], { warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(0);
    expect(loaded.providerFactories.size).toBe(0);
    expect(warnings.join("\n")).toContain("ASTRO_PLUGIN_ALLOWLIST");
  });

  test("allowlist libera o pacote remoto", async () => {
    const warnings: string[] = [];
    await loadPlugins(["dark-plugin"], { allowlist: new Set(["dark-plugin"]), warn: (m) => warnings.push(m) });
    expect(warnings.join("\n")).not.toContain("ASTRO_PLUGIN_ALLOWLIST");
  });

  test("caminho local não exige allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-plugin-"));
    const warnings: string[] = [];
    const loaded = await loadPlugins([writePlugin(dir)], { warn: (m) => warnings.push(m) });
    expect(loaded.tools).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  test("allowlist do env é lista separada por vírgula", () => {
    expect([...pluginAllowlistFromEnv({ ASTRO_PLUGIN_ALLOWLIST: "a, b ,," })]).toEqual(["a", "b"]);
    expect([...pluginAllowlistFromEnv({})]).toEqual([]);
  });
});