import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";

function cfg(model: Record<string, unknown>): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "http://p/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192, ...model }],
    agent: { model: "p/m", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("eficiência do modelo (M6/M8)", () => {
  test("eficiência 0..1 é preservada", () => {
    expect(validateConfig(cfg({ efficiency: 0.75 })).models[0]!.efficiency).toBe(0.75);
    expect(validateConfig(cfg({})).models[0]!.efficiency).toBeUndefined();
  });

  test("eficiência fora de 0..1 ou inválida falha", () => {
    expect(() => validateConfig(cfg({ efficiency: 1.5 }))).toThrow(/efficiency/);
    expect(() => validateConfig(cfg({ efficiency: -0.1 }))).toThrow(/efficiency/);
    expect(() => validateConfig(cfg({ efficiency: "high" }))).toThrow(/efficiency/);
  });
});
