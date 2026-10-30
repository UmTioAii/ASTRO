import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/config";

function cfg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "P2_KEY" },
    },
    models: [{ provider: "p1", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p1/m1", maxSteps: 2, tools: [] },
    agents: { planner: { model: "p1/m1" } },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...over,
  };
}

describe("teto de agentes ativos vs contas declaradas (A2, ADR-0008)", () => {
  test("agents nomeados exigem ao menos 2 contas: max_active_exceeds_accounts", () => {
    const one = cfg({
      providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" } },
    });
    expect(() => validateConfig(one)).toThrow(ConfigError);
    expect(() => validateConfig(one)).toThrow(/max_active_exceeds_accounts/);
  });

  test("duas contas declaradas passam e maxActive fica ausente", () => {
    const parsed = validateConfig(cfg());
    expect(parsed.agents?.planner?.model).toBe("p1/m1");
    expect(parsed.maxActive).toBeUndefined();
  });

  test("credenciais repetidas contam como uma única conta", () => {
    const shared = cfg({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "SAME_KEY" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "SAME_KEY" },
      },
    });
    expect(() => validateConfig(shared)).toThrow(/max_active_exceeds_accounts/);
  });

  test("provider sem credencial conta como conta própria por provider", () => {
    const keyless = cfg({
      providers: {
        local: { kind: "openai-compat", baseUrl: "http://local/v1" },
        other: { kind: "openai-compat", baseUrl: "http://other/v1" },
      },
    });
    expect(() => validateConfig(keyless)).not.toThrow();
  });

  test("maxActive declarado é validado contra as contas (v2: 4)", () => {
    const three = cfg({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "P2_KEY" },
        p3: { kind: "openai-compat", baseUrl: "http://p3/v1", credentialRef: "P3_KEY" },
      },
      agents: { maxActive: 4, planner: { model: "p1/m1" } },
    });
    expect(() => validateConfig(three)).toThrow(/max_active_exceeds_accounts/);

    const four = cfg({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "P2_KEY" },
        p3: { kind: "openai-compat", baseUrl: "http://p3/v1", credentialRef: "P3_KEY" },
        p4: { kind: "openai-compat", baseUrl: "http://p4/v1", credentialRef: "P4_KEY" },
      },
      agents: { maxActive: 4, planner: { model: "p1/m1" } },
    });
    const parsed = validateConfig(four);
    expect(parsed.maxActive).toBe(4);
    expect(Object.keys(parsed.agents ?? {})).toEqual(["planner"]);
  });

  test("maxActive inválido falha na validação da config", () => {
    expect(() => validateConfig(cfg({ agents: { maxActive: 0, planner: { model: "p1/m1" } } }))).toThrow(
      /maxActive/,
    );
    expect(() => validateConfig(cfg({ agents: { maxActive: 2.5, planner: { model: "p1/m1" } } }))).toThrow(
      /maxActive/,
    );
  });

  test("config de agente único continua válida com uma conta", () => {
    const single = cfg({
      providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" } },
      agents: undefined,
    });
    expect(() => validateConfig(single)).not.toThrow();
  });
});
