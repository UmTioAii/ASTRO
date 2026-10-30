import { describe, expect, test } from "bun:test";
import {
  applyCallToBody,
  applyEffortChange,
  normalizeLevel,
  planEffortChange,
  resolveCallProfile,
  type CallConfig,
} from "../src/call-profile";

const call: CallConfig = {
  effort: {
    param: "reasoning.effort",
    map: { "0": "minimal", "1": "low", "2": "medium", "3": "high", "4": "ultra" },
  },
  thinking: { mode: "toggle", param: "thinking.type", on: "enabled", off: "disabled" },
};

describe("call profile (S-08, #125)", () => {
  test("lvl 0..4 resolve pelo effort map; default 2 quando o modelo declara effort (E1)", () => {
    expect(resolveCallProfile(call)).toMatchObject({ lvl: 2, effort: "medium", thinking: "enabled", stripped: [] });
    expect(resolveCallProfile(call, { lvl: 0 })).toMatchObject({ lvl: 0, effort: "minimal" });
    expect(resolveCallProfile(call, { lvl: 4 })).toMatchObject({ lvl: 4, effort: "ultra" });
    expect(normalizeLevel(3)).toBe(3);
    expect(() => normalizeLevel(5)).toThrow(RangeError);
    expect(() => normalizeLevel(-1)).toThrow(RangeError);
    expect(() => normalizeLevel(1.5)).toThrow(RangeError);
  });

  test("thinking é independente do effort (E2) e respeita os modos", () => {
    expect(resolveCallProfile(call, { lvl: 0, thinking: "off" })).toMatchObject({ lvl: 0, effort: "minimal", thinking: "disabled" });
    expect(resolveCallProfile({ thinking: { mode: "always", param: "x", on: "on" } }, { thinking: "off" }).thinking).toBe("on");
    expect(resolveCallProfile({ thinking: { mode: "adaptive", param: "x", on: "adaptive" } }).thinking).toBe("adaptive");
    expect(resolveCallProfile({ thinking: { mode: "none", param: "x" } }).thinking).toBeUndefined();
    expect(resolveCallProfile(undefined)).toEqual({ stripped: [] });
  });

  test("aplica params aninhados no corpo do provider", () => {
    const body: Record<string, unknown> = { model: "m", messages: [] };
    const applied = applyCallToBody(body, call, { lvl: 3, thinking: "off" });

    expect(body).toEqual({
      model: "m",
      messages: [],
      reasoning: { effort: "high" },
      thinking: { type: "disabled" },
    });
    expect(applied).toMatchObject({ lvl: 3, effort: "high", thinking: "disabled", stripped: [] });
  });

  test("forbidden remove o parâmetro antes do envio e grava {name, reason} (E8)", () => {
    const body: Record<string, unknown> = { model: "m", temperature: 0.7, reasoning: { effort: "low", budget: 100 } };
    const applied = applyCallToBody(body, { forbidden: ["temperature", "reasoning.budget", "absent"] });

    expect(body).toEqual({ model: "m", reasoning: { effort: "low" } });
    expect(applied.stripped).toEqual([
      { name: "temperature", reason: "forbidden" },
      { name: "reasoning.budget", reason: "forbidden" },
    ]);
  });

  test("forbidden ancestral limpa o applied do parâmetro coberto", () => {
    const body: Record<string, unknown> = { model: "m", reasoning: { effort: "low" }, thinking: { type: "enabled" } };
    const applied = applyCallToBody(body, { ...call, forbidden: ["reasoning", "thinking"] }, { lvl: 3 });

    expect(body).toEqual({ model: "m" });
    expect(applied.effort).toBeUndefined();
    expect(applied.thinking).toBeUndefined();
    expect(applied.stripped).toEqual([
      { name: "reasoning", reason: "forbidden" },
      { name: "thinking", reason: "forbidden" },
    ]);
  });

  test("caminho de parâmetro com chave de protótipo é recusado em runtime", () => {
    expect(() => applyCallToBody({}, {
      effort: { param: "__proto__.effort", map: { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" } },
    })).toThrow(RangeError);
    expect(() => applyCallToBody({}, { forbidden: ["constructor.type"] })).toThrow(RangeError);
  });

  test("raízes de protocolo são recusadas em runtime mesmo sem validar a config", () => {
    expect(() => applyCallToBody({}, {
      effort: { param: "model", map: { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" } },
    })).toThrow(RangeError);
    expect(() => applyCallToBody({}, {
      thinking: { mode: "always", param: "instructions", on: "x" },
    })).toThrow(RangeError);
    expect(() => applyCallToBody({}, { forbidden: ["messages"] })).toThrow(RangeError);
  });

  test("subir 1–2 níveis é automático; 3+ pede aprovação (E4); descer é automático (E5)", () => {
    expect(planEffortChange(1, 3)).toEqual({ allowed: true, approvalRequired: false, level: 3, reason: "up_auto" });
    expect(planEffortChange(1, 4)).toEqual({ allowed: false, approvalRequired: true, level: 1, reason: "up_needs_approval" });
    expect(planEffortChange(4, 1)).toEqual({ allowed: true, approvalRequired: false, level: 1, reason: "down" });
    expect(planEffortChange(2, 2)).toEqual({ allowed: true, approvalRequired: false, level: 2, reason: "same" });
  });

  test("valor fixado pelo usuário nunca é sobrescrito (E3)", () => {
    expect(planEffortChange(1, 3, { fixed: true })).toEqual({
      allowed: false, approvalRequired: false, level: 1, reason: "fixed",
    });
  });

  test("applyEffortChange consulta o approver só quando E4 exige", async () => {
    let asked = 0;
    expect(await applyEffortChange(1, 4, { approve: () => { asked++; return true; } }))
      .toEqual({ allowed: true, approvalRequired: false, level: 4, reason: "up_approved" });
    expect(asked).toBe(1);
    expect(await applyEffortChange(1, 4, { approve: () => false }))
      .toEqual({ allowed: false, approvalRequired: true, level: 1, reason: "up_needs_approval" });
    expect((await applyEffortChange(1, 4)).allowed).toBe(false);
    await applyEffortChange(4, 1, { approve: () => { asked++; return true; } });
    expect(asked).toBe(1);
  });
});
