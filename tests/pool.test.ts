import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/config";
import { Registry } from "../src/registry";
import { formatPoolList } from "../src/pool";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const baseConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  providers: { openai: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "X_KEY" } },
  models: [
    { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, capabilities: { tools: true } },
    { provider: "openai", id: "llama-3", tags: ["analysis"], context: 8192 },
  ],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  ...over,
});

const poolCfg = () =>
  baseConfig({
    modelPool: {
      "coding-premium": { model: "openai/gpt-4o-mini", capabilities: ["tools"] },
      "cheap-explorer": { model: "openai/llama-3" },
    },
  });

const failMessage = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("modelPool no config (F-27)", () => {
  test("seção válida é preservada, incluindo capabilities e fallback", () => {
    const cfg = validateConfig(
      baseConfig({
        modelPool: {
          "coding-premium": { model: "openai/gpt-4o-mini", capabilities: ["tools"] },
          "cheap-explorer": { model: "openai/llama-3", fallback: ["coding-premium"] },
        },
      }),
    );
    expect(cfg.modelPool!["coding-premium"].model).toBe("openai/gpt-4o-mini");
    expect(cfg.modelPool!["cheap-explorer"].fallback).toEqual(["coding-premium"]);
  });

  test("rejeições: sem model, model inexistente, não active, capability desconhecida/ausente, fallback vazio/inexistente", () => {
    expect(failMessage(() => validateConfig(baseConfig({ modelPool: { p1: { capabilities: ["tools"] } } })))).toContain("model");
    expect(failMessage(() => validateConfig(baseConfig({ modelPool: { p1: { model: "openai/fantasma" } } })))).toContain("p1");
    const disabled = baseConfig({
      models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "deprecated" }],
    });
    expect(failMessage(() => validateConfig({ ...disabled, modelPool: { p1: { model: "openai/gpt-4o-mini" } } }))).toContain("active");
    expect(failMessage(() => validateConfig(baseConfig({ modelPool: { p1: { model: "openai/llama-3", capabilities: ["vision"] } } })))).toContain("vision");
    expect(failMessage(() => validateConfig(baseConfig({ modelPool: { p1: { model: "openai/llama-3", capabilities: ["tools"] } } })))).toContain("tools");
    expect(failMessage(() => validateConfig(baseConfig({ modelPool: { p1: { model: "openai/llama-3", fallback: [] } } })))).toContain("fallback");
    expect(failMessage(() => validateConfig(baseConfig({ modelPool: { p1: { model: "openai/llama-3", fallback: ["nao-existe"] } } })))).toContain("nao-existe");
  });
});

describe("agents[*].profile (F-27)", () => {
  test("agent.profile resolve o model no objeto validado", () => {
    const cfg = validateConfig(
      baseConfig({
        modelPool: { "cheap-explorer": { model: "openai/llama-3" } },
        agent: { profile: "cheap-explorer", maxSteps: 5, tools: [] },
      }),
    );
    expect(cfg.agent.model).toBe("openai/llama-3");
    expect(cfg.agent.profile).toBe("cheap-explorer");
  });

  test("rejeições: profile+model juntos (default e nomeado) e profile inexistente", () => {
    const withPool = baseConfig({ modelPool: { p1: { model: "openai/llama-3" } } });
    expect(
      failMessage(() => validateConfig({ ...withPool, agent: { profile: "p1", model: "openai/gpt-4o-mini", maxSteps: 5, tools: [] } })),
    ).toContain("profile");
    expect(
      failMessage(() => validateConfig({ ...withPool, agents: { coder: { profile: "p1", model: "openai/gpt-4o-mini" } } })),
    ).toContain("profile");
    expect(failMessage(() => validateConfig(baseConfig({ agent: { profile: "fantasma", maxSteps: 5, tools: [] } })))).toContain("fantasma");
  });

  test("named agent com profile resolve o model e herda maxSteps/tools do base", () => {
    const cfg = validateConfig(
      baseConfig({
        modelPool: { "cheap-explorer": { model: "openai/llama-3" } },
        agents: { explorer: { profile: "cheap-explorer" } },
      }),
    );
    expect(cfg.agents!.explorer.model).toBe("openai/llama-3");
    expect(cfg.agents!.explorer.profile).toBe("cheap-explorer");
    expect(cfg.agents!.explorer.maxSteps).toBe(5);
  });

  test("sem profile, comportamento atual preservado (model herdado do base)", () => {
    const cfg = validateConfig(baseConfig({ agents: { coder: {} } }));
    expect(cfg.agents!.coder.model).toBe("openai/gpt-4o-mini");
    expect(cfg.agents!.coder.profile).toBeUndefined();
  });
});

describe("resolveProfile no Registry (F-27)", () => {
  test("devolve o ModelEntry ativo do profile; erros citam o nome e a seção ausente", () => {
    const r = new Registry(validateConfig(poolCfg()));
    expect(r.resolveProfile("coding-premium").id).toBe("gpt-4o-mini");
    expect(r.resolveProfile("cheap-explorer").id).toBe("llama-3");
    expect(failMessage(() => r.resolveProfile("fantasma"))).toContain("fantasma");
    const vazio = new Registry(validateConfig(baseConfig()));
    expect(failMessage(() => vazio.resolveProfile("p1"))).toContain("modelPool");
  });
});

describe("formatPoolList e CLI (F-27)", () => {
  test("linhas com nome, modelo resolvido, tags, exigências, fallback; sem pool, mensagem clara", () => {
    const cfg = validateConfig(
      baseConfig({
        modelPool: {
          "coding-premium": { model: "openai/gpt-4o-mini", capabilities: ["tools"] },
          "cheap-explorer": { model: "openai/llama-3", fallback: ["coding-premium"] },
        },
      }),
    );
    const out = formatPoolList(cfg);
    expect(out).toContain("coding-premium");
    expect(out).toContain("openai/gpt-4o-mini");
    expect(out).toContain("writing-code");
    expect(out).toContain("exige tools");
    expect(out).toContain("fallback coding-premium");
    expect(out).toContain("cheap-explorer");
    expect(formatPoolList(validateConfig(baseConfig()))).toContain("nenhum profile");
  });

  test("bun src/cli.ts pool list imprime os profiles do config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-pool-cli-"));
    const cfgPath = join(dir, "astro.config.json");
    writeFileSync(cfgPath, JSON.stringify(poolCfg()), "utf8");
    const proc = Bun.spawn(["bun", "src/cli.ts", "pool", "list", "--config", cfgPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(exit).toBe(0);
    expect(out).toContain("coding-premium");
    expect(out).toContain("cheap-explorer");
    expect(out).toContain("openai/llama-3");
  });
});
