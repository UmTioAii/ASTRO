import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/config";
import { isKnownTag } from "../src/tags";

const valid = {
  providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
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

test("vocabulário de tags é fechado", () => {
  expect(isKnownTag("writing-code")).toBe(true);
  expect(isKnownTag("telepathy")).toBe(false);
});
