import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { ConfigError, validateConfig } from "../src/config";
import { formatProvidersList, runHealthCheck, testProvider } from "../src/health";

const baseConfig = {
  providers: {
    a: { kind: "openai-compat", baseUrl: "http://a/v1", credentialRef: "KEY_A", priority: 1, fallback: ["b"], quotaDomain: "dom-a" },
    b: { kind: "openai-compat", baseUrl: "http://b/v1", credentialRef: "KEY_B" },
  },
  models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 4096 }],
  agent: { model: "a/m1", maxSteps: 2, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};
const cfg = () => validateConfig(structuredClone(baseConfig));
const fetchOk = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

describe("providers avançados (C6b)", () => {
  test("formatProvidersList mostra prioridade, cadeia de fallback e defaults", () => {
    const out = formatProvidersList(cfg());
    expect(out).toContain("a");
    expect(out).toContain("openai-compat");
    expect(out).toContain("prioridade 1");
    expect(out).toContain("b");       // cadeia de fallback de a
    expect(out).toContain("dom-a");
    expect(out).toContain("prioridade 100"); // default de b
    expect(out).toContain("default");        // quotaDomain default de b
    expect(formatProvidersList({ ...cfg(), providers: {} } as ReturnType<typeof cfg>)).toContain("nenhum provider");
  });

  test("health report carrega a prioridade de cada provider (visão por prioridade)", async () => {
    const report = await runHealthCheck(cfg(), { KEY_A: "k", KEY_B: "k" }, { fetchLike: fetchOk });
    expect(report.checks.find((c) => c.name === "provider:a")!.priority).toBe(1);
    expect(report.checks.find((c) => c.name === "provider:b")!.priority).toBe(100);
  });

  test("testProvider faz 1 chamada real mínima e reporta latência com prioridade", async () => {
    const check = await testProvider(cfg(), "a", { KEY_A: "k" }, { fetchLike: fetchOk });
    expect(check.name).toBe("provider:a");
    expect(check.status).toBe("ok");
    expect(check.priority).toBe(1);
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("testProvider: provider fora → ConfigError; endpoint fora → down; credencial ausente → down citando o nome", async () => {
    await expect(testProvider(cfg(), "ghost", {})).rejects.toThrow(/ghost/);
    const down = await testProvider(cfg(), "a", { KEY_A: "k" }, { fetchLike: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch });
    expect(down.status).toBe("down");
    const noKey = await testProvider(cfg(), "a", {}, { fetchLike: fetchOk });
    expect(noKey.status).toBe("down");
    expect(noKey.detail).toContain("KEY_A"); // nome da variável, nunca o valor (I-03)
  });

  test("testProvider com codex-oauth valida o arquivo de credenciais", async () => {
    const credPath = join(mkdtempSync(join(tmpdir(), "astro-c6b-")), "auth.json");
    writeFileSync(credPath, "{}");
    const config = validateConfig(structuredClone({ ...baseConfig, providers: { ...baseConfig.providers, codex: { kind: "codex-oauth", credentialsPath: credPath } } }));
    const ok = await testProvider(config, "codex", {});
    expect(ok.status).toBe("ok");
    const missing = await testProvider(config, "codexx", {}).then(() => null, (e) => e as ConfigError);
    expect(missing?.message).toContain("codexx");
  });
});
