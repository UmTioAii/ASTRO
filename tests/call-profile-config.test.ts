import { describe, expect, test } from "bun:test";
import type { CallConfig } from "../src/call-profile";
import { validateConfig } from "../src/config";

function cfg(call?: unknown): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "http://p/v1", credentialRef: "P_KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192, ...(call === undefined ? {} : { call }) }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

const validCall: CallConfig = {
  effort: { param: "reasoning.effort", map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "ultra" } },
  thinking: { mode: "toggle", param: "thinking.type", on: "enabled", off: "disabled" },
  forbidden: ["temperature"],
};

describe("config call profile por modelo (E1–E8, D-CFG1)", () => {
  test("call válido é preservado no modelo", () => {
    const parsed = validateConfig(cfg(validCall));
    expect(parsed.models[0]!.call).toEqual(validCall);
  });

  test("config sem call continua válida", () => {
    expect(validateConfig(cfg()).models[0]!.call).toBeUndefined();
  });

  test("M8 ids aceitam os mapas oficiais documentados (E6)", () => {
    const cfg = {
      providers: {
        nvidia: { kind: "openai-compat", baseUrl: "http://nvidia/v1", credentialRef: "NVIDIA_API_KEY" },
        openrouter: { kind: "openai-compat", baseUrl: "http://openrouter/v1", credentialRef: "OPENROUTER_API_KEY" },
        codex: { kind: "codex-oauth", credentialsPath: "~/.codex/auth.json" },
      },
      models: [
        { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", tags: ["writing-code"], context: 131072,
          call: { effort: { param: "reasoning.effort", map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "max" } } } },
        { provider: "openrouter", id: "openai/gpt-4o-mini", tags: ["writing-code"], context: 128000,
          call: { effort: { param: "reasoning.effort", map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "max" } } } },
        { provider: "codex", id: "gpt-5.5", tags: ["writing-code"], context: 400000,
          call: { effort: { param: "reasoning.effort", map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "max" } } } },
      ],
      agent: { model: "nvidia/meta/llama-3.3-70b-instruct", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    };
    const parsed = validateConfig(cfg);
    expect(parsed.models.map((m) => m.call?.effort?.param)).toEqual([
      "reasoning.effort", "reasoning.effort", "reasoning.effort",
    ]);
  });

  test("campo desconhecido em call falha (non-discard)", () => {
    expect(() => validateConfig(cfg({ ...validCall, nope: true }))).toThrow(/call/);
  });

  test("thinking inválido falha: modo, param e on/off obrigatórios", () => {
    expect(() => validateConfig(cfg({ thinking: { mode: "sometimes", param: "x" } }))).toThrow(/thinking.mode/);
    expect(() => validateConfig(cfg({ thinking: { mode: "toggle", param: "x", on: "on" } }))).toThrow(/thinking.off/);
    expect(() => validateConfig(cfg({ thinking: { mode: "always", param: "x" } }))).toThrow(/thinking.on/);
    expect(() => validateConfig(cfg({ thinking: { mode: "always", param: "" , on: "on" } }))).toThrow(/thinking.param/);
  });

  test("effort inválido falha: map precisa dos níveis 0..4", () => {
    const map = { "0": "a", "1": "b", "2": "c", "3": "d" };
    expect(() => validateConfig(cfg({ effort: { param: "reasoning.effort", map } }))).toThrow(/effort.map/);
    expect(() => validateConfig(cfg({ effort: { param: "reasoning.effort", map: { ...map, "4": "e", "5": "f" } } }))).toThrow(/effort.map/);
    expect(() => validateConfig(cfg({ effort: { param: "reasoning.effort", map: { ...map, "4": 1 } } }))).toThrow(/effort.map.4/);
  });

  test("forbidden rejeita não-lista, vazio, duplicado e raiz protegida", () => {
    expect(() => validateConfig(cfg({ forbidden: "temperature" }))).toThrow(/forbidden/);
    expect(() => validateConfig(cfg({ forbidden: [""] }))).toThrow(/forbidden/);
    expect(() => validateConfig(cfg({ forbidden: ["temperature", "temperature"] }))).toThrow(/forbidden/);
    expect(() => validateConfig(cfg({ forbidden: ["model"] }))).toThrow(/forbidden/);
    expect(() => validateConfig(cfg({ forbidden: ["messages.0"] }))).toThrow(/forbidden/);
  });
});
