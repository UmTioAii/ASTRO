import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";

function cfg(compaction?: unknown): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "http://p/v1", credentialRef: "P_KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    ...(compaction === undefined ? {} : { compaction }),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("config compaction (S-17, CMP-1, D-CFG1)", () => {
  test("ausente resolve para buffer null (default do ADR-0015)", () => {
    expect(validateConfig(cfg()).compaction).toEqual({ buffer: null });
  });

  test("buffer explícito inteiro >= 0 é preservado", () => {
    expect(validateConfig(cfg({ buffer: 8_000 })).compaction).toEqual({ buffer: 8_000 });
    expect(validateConfig(cfg({ buffer: 0 })).compaction).toEqual({ buffer: 0 });
    expect(validateConfig(cfg({ buffer: null })).compaction).toEqual({ buffer: null });
  });

  test("valores inválidos falham (non-discard)", () => {
    expect(() => validateConfig(cfg({ buffer: -1 }))).toThrow(/compaction.buffer/);
    expect(() => validateConfig(cfg({ buffer: 1.5 }))).toThrow(/compaction.buffer/);
    expect(() => validateConfig(cfg({ buffer: "8000" }))).toThrow(/compaction.buffer/);
    expect(() => validateConfig(cfg({ nope: true }))).toThrow(/compaction/);
    expect(() => validateConfig(cfg(8000))).toThrow(/compaction/);
  });
});
