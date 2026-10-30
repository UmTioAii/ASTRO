import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";

function cfg(outputLimit?: unknown): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "http://p/v1", credentialRef: "P_KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    ...(outputLimit === undefined ? {} : { outputLimit }),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("config outputLimit (S-16, CMP-10, D-CFG1)", () => {
  test("ausente resolve para maxTokens 8000 e shareOfWindow 0,05", () => {
    expect(validateConfig(cfg()).outputLimit).toEqual({ maxTokens: 8000, shareOfWindow: 0.05 });
  });

  test("campo parcial completa o default", () => {
    expect(validateConfig(cfg({ maxTokens: 1000 })).outputLimit)
      .toEqual({ maxTokens: 1000, shareOfWindow: 0.05 });
    expect(validateConfig(cfg({ shareOfWindow: 0.1 })).outputLimit)
      .toEqual({ maxTokens: 8000, shareOfWindow: 0.1 });
  });

  test("valores inválidos falham (non-discard)", () => {
    expect(() => validateConfig(cfg({ maxTokens: 0 }))).toThrow(/outputLimit.maxTokens/);
    expect(() => validateConfig(cfg({ maxTokens: 1.5 }))).toThrow(/outputLimit.maxTokens/);
    expect(() => validateConfig(cfg({ maxTokens: "8000" }))).toThrow(/outputLimit.maxTokens/);
    expect(() => validateConfig(cfg({ shareOfWindow: 0 }))).toThrow(/outputLimit.shareOfWindow/);
    expect(() => validateConfig(cfg({ shareOfWindow: 1.1 }))).toThrow(/outputLimit.shareOfWindow/);
    expect(() => validateConfig(cfg({ nope: true }))).toThrow(/outputLimit/);
    expect(() => validateConfig(cfg("8000"))).toThrow(/outputLimit/);
  });
});
