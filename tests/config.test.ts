import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/config";
import type { ModelConfig, ModelStatus } from "../src/config";
import { isKnownTag } from "../src/tags";

const valid = {
  providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }] as ModelConfig[],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file", "write_file", "run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const validWithAgents = {
  ...valid,
  providers: {
    ...valid.providers,
    backup: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "BACKUP_API_KEY" },
  },
  agents: {
    planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["read_file"], systemPrompt: "Planeje a tarefa" },
    coder: { model: "openai/gpt-4o-mini", maxSteps: 15, tools: ["read_file", "write_file", "run_command"] },
    reviewer: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["read_file"] },
  },
};

describe("config", () => {
  test("config válida ganha defaults", () => {
    const cfg = validateConfig(structuredClone(valid));
    expect(cfg.models[0].status).toBe("active");
    expect(cfg.providers.openai.quotaDomain).toBe("default");
  });
  test("tag fora do vocabulário fechado → ConfigError", () => {
    const bad = structuredClone(valid);
    bad.models[0].tags.push("telepathy");
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });
  test("modelo apontando para provider inexistente → ConfigError", () => {
    const bad = structuredClone(valid);
    bad.models[0].provider = "ghost";
    expect(() => validateConfig(bad)).toThrow(/provider/);
  });
  test("agent.model precisa referenciar modelo declarado", () => {
    const bad = structuredClone(valid);
    bad.agent.model = "openai/ghost";
    expect(() => validateConfig(bad)).toThrow(/agent\.model/);
  });
});

describe("agents (F3-1)", () => {
  test("config com agents válida passa", () => {
    const cfg = validateConfig(structuredClone(validWithAgents));
    expect(cfg.agents).toBeDefined();
    expect(Object.keys(cfg.agents!)).toEqual(["planner", "coder", "reviewer"]);
    expect(cfg.agents!.planner.model).toBe("openai/gpt-4o-mini");
    expect(cfg.agents!.planner.maxSteps).toBe(10);
    expect(cfg.agents!.planner.tools).toEqual(["read_file"]);
    expect(cfg.agents!.planner.systemPrompt).toBe("Planeje a tarefa");
  });
  test("agent com model inexistente → ConfigError", () => {
    const bad = structuredClone(validWithAgents);
    bad.agents!.planner.model = "openai/ghost";
    expect(() => validateConfig(bad)).toThrow(/agent.*referencia modelo.*não declarado/);
  });
  test("agent com model inativo (deprecated) → ConfigError", () => {
    const bad = structuredClone(validWithAgents);
    bad.models = [...bad.models, { provider: "openai", id: "old-model", tags: ["fast"], context: 8192, status: "deprecated" as const }];
    bad.agents!.planner.model = "openai/old-model";
    expect(() => validateConfig(bad)).toThrow(/agent.*referencia modelo.*não está active/);
  });
  test("agent com tool fora da allowlist global → ConfigError", () => {
    const bad = structuredClone(validWithAgents);
    bad.agents!.planner.tools = ["read_file", "tool_inexistente"];
    expect(() => validateConfig(bad)).toThrow(/agent.*tool.*desconhecida/);
  });
  test("agent sem maxSteps usa default do agent principal", () => {
    const noMaxSteps = structuredClone(validWithAgents);
    (noMaxSteps.agents!.planner as any).maxSteps = undefined;
    const cfg = validateConfig(noMaxSteps);
    expect(cfg.agents!.planner.maxSteps).toBe(valid.agent.maxSteps);
  });
  test("agent sem tools herda do agent principal", () => {
    const noTools = structuredClone(validWithAgents);
    (noTools.agents!.planner as any).tools = undefined;
    const cfg = validateConfig(noTools);
    expect(cfg.agents!.planner.tools).toEqual(valid.agent.tools);
  });
});

describe("handoff (F-24)", () => {
  test("sem seção handoff o ackTimeoutMs default é 30000 (D-15)", () => {
    const cfg = validateConfig(structuredClone(valid));
    expect(cfg.handoff?.ackTimeoutMs).toBe(30_000);
  });
  test("ackTimeoutMs inválido → ConfigError", () => {
    const bad = structuredClone(valid) as typeof valid & { handoff?: { ackTimeoutMs?: unknown } };
    bad.handoff = { ackTimeoutMs: 0 };
    expect(() => validateConfig(bad)).toThrow(/handoff\.ackTimeoutMs/);
  });
  test("ackTimeoutMs válido é preservado", () => {
    const cfg = validateConfig({ ...structuredClone(valid), handoff: { ackTimeoutMs: 5_000 } });
    expect(cfg.handoff?.ackTimeoutMs).toBe(5_000);
  });
});

test("vocabulário de tags é fechado", () => {
  expect(isKnownTag("writing-code")).toBe(true);
  expect(isKnownTag("telepathy")).toBe(false);
});

describe("cross-provider same-model-id semantics (S-06, #123)", () => {
  test("mesmo id em providers diferentes é válido e distinto (composite identity provider/id)", () => {
    const cfg = validateConfig({
      providers: {
        nvidia: { kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", credentialRef: "NVIDIA_API_KEY" },
        openrouter: { kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", credentialRef: "OPENROUTER_API_KEY" },
      },
      models: [
        { provider: "nvidia", id: "llama-3.3-70b-instruct", tags: ["writing-code"], context: 128000 },
        { provider: "openrouter", id: "llama-3.3-70b-instruct", tags: ["writing-code"], context: 128000 },
      ],
      agent: { model: "nvidia/llama-3.3-70b-instruct", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    });
    expect(cfg.models).toHaveLength(2);
    expect(cfg.models[0].provider).toBe("nvidia");
    expect(cfg.models[1].provider).toBe("openrouter");
    // Ambos selecionáveis via composite identity
    expect(cfg.models.find((m) => m.provider === "nvidia" && m.id === "llama-3.3-70b-instruct")).toBeDefined();
    expect(cfg.models.find((m) => m.provider === "openrouter" && m.id === "llama-3.3-70b-instruct")).toBeDefined();
  });

  test("duplicado exato provider/id ainda falha com mensagem existente", () => {
    const bad = {
      providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
      models: [
        { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 },
        { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 },
      ],
      agent: { model: "openai/gpt-4o-mini", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    };
    expect(() => validateConfig(bad)).toThrow(/modelo duplicado/);
  });

  test("modelo id existente em um provider não é resolvido implicitamente por outro provider", () => {
    const cfg = validateConfig({
      providers: {
        nvidia: { kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", credentialRef: "NVIDIA_API_KEY" },
        openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" },
      },
      models: [
        { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", tags: ["writing-code"], context: 128000 },
        { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 },
      ],
      agent: { model: "nvidia/meta/llama-3.3-70b-instruct", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    });
    // openai/gpt-4o-mini NÃO resolve nvidia/meta/llama-3.3-70b-instruct
    // O registry lookup requer composite identity provider/id
    expect(cfg.models.find((m) => m.provider === "openai" && m.id === "meta/llama-3.3-70b-instruct")).toBeUndefined();
    expect(cfg.models.find((m) => m.provider === "nvidia" && m.id === "meta/llama-3.3-70b-instruct")).toBeDefined();
  });
});
