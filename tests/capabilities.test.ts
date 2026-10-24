import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_KEYS,
  isKnownCapability,
  missingCapabilities,
  type Capability,
} from "../src/capabilities";
import { validateConfig } from "../src/config";
import { Registry } from "../src/registry";

const baseModel = (over: Record<string, unknown> = {}) => ({
  provider: "openai",
  id: "gpt-4o-mini",
  tags: ["writing-code"],
  context: 128000,
  ...over,
});

const baseConfig = (models: unknown[]): unknown => ({
  providers: { openai: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "X_KEY" } },
  models,
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});

describe("vocabulário de capabilities (F-07)", () => {
  test("chaves fechadas: tools, streaming, jsonMode", () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(["jsonMode", "streaming", "tools"]);
    expect(isKnownCapability("tools")).toBe(true);
    expect(isKnownCapability("jsonMode")).toBe(true);
    expect(isKnownCapability("streaming")).toBe(true);
    expect(isKnownCapability("vision")).toBe(false);
    expect(isKnownCapability("")).toBe(false);
  });

  test("missingCapabilities: exigida ausente quando não declarada ou false", () => {
    const m = { capabilities: { tools: true, streaming: false } };
    expect(missingCapabilities(m, ["tools"])).toEqual([]);
    expect(missingCapabilities(m, ["streaming"])).toEqual(["streaming"]);
    expect(missingCapabilities(m, ["jsonMode" as Capability])).toEqual(["jsonMode"]);
    expect(missingCapabilities({}, ["tools"])).toEqual(["tools"]);
    expect(missingCapabilities({ capabilities: undefined }, ["tools"])).toEqual(["tools"]);
  });

  test("missingCapabilities devolve todas as ausentes na ordem exigida", () => {
    const m = { capabilities: {} };
    expect(missingCapabilities(m, ["jsonMode", "tools", "streaming"])).toEqual([
      "jsonMode",
      "tools",
      "streaming",
    ]);
  });
});

describe("capabilities no config (F-07)", () => {
  test("modelo com capabilities válidas passa e é preservado", () => {
    const cfg = validateConfig(baseConfig([baseModel({ capabilities: { tools: true, jsonMode: false } })]));
    expect(cfg.models[0].capabilities).toEqual({ tools: true, jsonMode: false });
  });

  test("chave desconhecida é rejeitada citando as conhecidas", () => {
    let msg = "";
    try {
      validateConfig(baseConfig([baseModel({ capabilities: { vision: true } })]));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("vision");
    expect(msg).toContain("tools");
  });

  test("valor não-booleano é rejeitado", () => {
    expect(() => validateConfig(baseConfig([baseModel({ capabilities: { tools: "sim" } })]))).toThrow(
      /booleano/,
    );
  });

  test("capabilities ausentes são válidas (seção aditiva)", () => {
    const cfg = validateConfig(baseConfig([baseModel()]));
    expect(cfg.models[0].capabilities).toBeUndefined();
  });

  test("context existente não entra em capabilities (sem duplicação)", () => {
    const cfg = validateConfig(baseConfig([baseModel({ capabilities: { tools: true } })]));
    expect(cfg.models[0].context).toBe(128000);
    expect(cfg.models[0].capabilities).not.toHaveProperty("context");
  });
});

describe("capabilities no registry (F-07)", () => {
  const config = validateConfig(
    baseConfig([
      baseModel({ capabilities: { tools: true } }),
      { provider: "openai", id: "llama-3", tags: ["analysis"], context: 8192 },
    ]),
  );

  test("list filtra por capability exigida; ausência de declaração é ausência", () => {
    const r = new Registry(config);
    expect(r.list({ capabilities: ["tools"] }).map((m) => m.id)).toEqual(["gpt-4o-mini"]);
    expect(r.list({ capabilities: ["jsonMode" as Capability] })).toEqual([]);
    expect(r.list().length).toBe(2);
    expect(r.list({ tags: ["analysis"], capabilities: ["tools"] })).toEqual([]);
  });

  test("require rejeita modelo sem capability exigida citando a ausente", () => {
    const r = new Registry(config);
    let msg = "";
    try {
      r.require("openai/llama-3", ["tools"]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("tools");
    expect(msg).toContain("openai/llama-3");
  });

  test("require aceita modelo com a capability exigida", () => {
    const r = new Registry(config);
    expect(r.require("openai/gpt-4o-mini", ["tools"]).id).toBe("gpt-4o-mini");
    expect(r.require("openai/llama-3").id).toBe("llama-3");
  });
});
