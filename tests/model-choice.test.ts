import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { validateConfig, type AstroConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import {
  CandidateSetChangedError,
  listModelCandidates,
  markModelHealthChanged,
  ModelChoiceError,
  resetCandidateSnapshots,
  resolveModelChoice,
  type CandidateDeps,
} from "../src/model-choice";
import { Registry } from "../src/registry";
import { markProviderFailure, markProviderSuccess } from "../src/provider/health-state";
import { createListModelCandidatesTool } from "../src/tools/list-model-candidates";

function config(over: Record<string, unknown> = {}): AstroConfig {
  return validateConfig({
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2", quotaDomain: "p2" },
    },
    models: [
      { provider: "p1", id: "cheap", tags: ["writing-code", "fast", "tools"], context: 8192, efficiency: 0.9,
        price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false }, capabilities: { tools: true } },
      { provider: "p1", id: "tooled", tags: ["writing-code", "tools"], context: 32000, efficiency: 0.4,
        price: { inputPerM: 2, outputPerM: 2, fonte: "t", verificado: false }, capabilities: { tools: true } },
      { provider: "p2", id: "noprice", tags: ["writing-code", "analysis", "tools"], context: 16000, efficiency: 0.8,
        capabilities: { tools: true } },
      { provider: "p2", id: "no-tools", tags: ["writing-code"], context: 16000, efficiency: 0.7 },
      { provider: "p2", id: "small", tags: ["writing-code"], context: 1024 },
      { provider: "p2", id: "disabled", tags: ["writing-code"], context: 8192, status: "disabled" },
      { provider: "p1", id: "older", tags: ["analysis", "writing-code", "tools"], context: 8192, efficiency: 0.5,
        price: { inputPerM: 3, outputPerM: 3, fonte: "t", verificado: false }, capabilities: { tools: true } },
    ],
    modelPool: {
      fast: { model: "p1/cheap" },
      tooled: { model: "p1/tooled" },
      noprice: { model: "p2/noprice" },
      "no-tools": { model: "p2/no-tools" },
      small: { model: "p2/small" },
      secondary: { model: "p1/older" },
    },
    agent: { model: "p1/cheap", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...over,
  });
}

function setup(cfg: AstroConfig = config()): CandidateDeps & { ledger: Ledger; audit: Auditor } {
  const dir = mkdtempSync(join(tmpdir(), "astro-candidates-"));
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const audit = new Auditor(join(dir, "audit.jsonl"));
  return {
    config: cfg,
    registry: new Registry(cfg),
    ledger,
    audit,
    ...(cfg.quota === undefined ? {} : { quotaLimits: cfg.quota }),
    ...(cfg.budget === undefined ? {} : { budget: cfg.budget }),
  };
}

beforeEach(() => resetCandidateSnapshots());

describe("pipeline de candidatos (S-09, ADR-0011)", () => {
  test("filtro duro: contexto, status, requires e tools; ranking por tag e custo", () => {
    const deps = setup();
    const snapshot = listModelCandidates({ need: "writing-code", requires: ["tools"], estimatedInputTokens: 8192 }, deps);

    expect(snapshot.ranking).toBe("cost");
    expect(snapshot.candidates.map((c) => c.profile)).toEqual(["fast", "tooled", "noprice", "secondary"]);
    expect(snapshot.candidates[0]).toMatchObject({ model: "p1/cheap", tags: ["writing-code", "fast", "tools"], efficiency: 0.9 });
    expect(snapshot.candidates[0]!.estimated_cost_max_usd).toBeCloseTo(0.008192, 6);
    expect(snapshot.expires_at).toBeDefined();
    expect(snapshot.snapshot_id).toHaveLength(64);
    expect(snapshot.candidates.some((c) => c.profile === "small")).toBe(false);

    const noPool = listModelCandidates({ need: "writing-code" }, setup(config({ modelPool: undefined })));
    expect(noPool.candidates.some((c) => c.model === "p2/disabled")).toBe(false);
  });

  test("requires desconhecido e need fora de ROLE_TAGS falham", () => {
    const deps = setup();
    expect(() => listModelCandidates({ need: "chef" }, deps)).toThrow(/invalid_need|não é um papel/);
    expect(() => listModelCandidates({ need: "writing-code", requires: ["quantum"] }, deps))
      .toThrow(/invalid_requires|não é uma capacidade/);
    expect(() => listModelCandidates({ need: "writing-code", requires: ["quantum"] }, deps))
      .toThrow(ModelChoiceError);
  });

  test("conta presa (A4) e cooldown excluem candidatos", () => {
    const deps = setup();
    const held = listModelCandidates({ need: "writing-code", requires: ["tools"] }, { ...deps, activeAccounts: new Set(["KEY1"]) });
    expect(held.candidates.every((c) => !c.model.startsWith("p1/"))).toBe(true);

    const cooled = listModelCandidates(
      { need: "writing-code", requires: ["tools"] },
      { ...deps, cooldown: ({ provider }) => provider === "p2" },
    );
    expect(cooled.candidates.every((c) => c.model.startsWith("p1/"))).toBe(true);
  });

  test("fallback de provider sem entrada em models[] usa o preço do primário", () => {
    const cfg = config({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1", fallback: ["p2"] },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2", quotaDomain: "p2" },
      },
      budget: { scope: "use-as-you-go", limitUsd: null, warnAt: 0.8, onExceed: "stop", hardCeilingUsd: 1 },
    });
    const snapshot = listModelCandidates({ need: "writing-code" }, setup(cfg));
    expect(snapshot.candidates.length).toBeGreaterThan(0);
    expect(snapshot.ranking).toBe("cost");
    // p1/cheap: 0.008192 no primário + 0.008192 no fallback que herda model.price
    expect(snapshot.candidates[0]!.estimated_cost_max_usd).toBeCloseTo(0.016384, 6);
  });

  test("reserva B9 inclui a cadeia de fallback de profile", () => {
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    const cfg = config({
      models: [
        { provider: "p1", id: "cheap", tags: ["writing-code"], context: 8192, price },
        { provider: "p1", id: "big", tags: ["writing-code"], context: 8192, price: { ...price, inputPerM: 8, outputPerM: 8 } },
        { provider: "p1", id: "tiny", tags: ["writing-code"], context: 8192, price: { ...price, inputPerM: 0.1, outputPerM: 0.1 } },
      ],
      modelPool: {
        fast: { model: "p1/cheap", fallback: ["big"] },
        big: { model: "p1/big" },
        tiny: { model: "p1/tiny" },
      },
      agent: { model: "p1/cheap", maxSteps: 2, tools: [] },
      budget: { scope: "day", limitUsd: 0.01, warnAt: 0.8, onExceed: "stop" },
    });
    const snapshot = listModelCandidates({ need: "writing-code" }, setup(cfg));
    expect(snapshot.candidates.map((c) => c.profile)).toEqual(["tiny"]);
  });

  test("gasto desconhecido no ledger nega o candidato sob teto físico (B6)", () => {
    const deps = setup(config({
      budget: { scope: "use-as-you-go", limitUsd: null, warnAt: 0.8, onExceed: "stop", hardCeilingUsd: 0.01 },
    }));
    deps.ledger.record({
      run: "r0", agent: "a", provider: "p1", model: "m", quotaDomain: "default", tokensIn: 1, tokensOut: 1,
    });
    expect(listModelCandidates({ need: "writing-code", requires: ["tools"] }, deps).candidates).toEqual([]);
  });

  test("snapshot expirado ainda devolve candidate_set_changed antes da carência", () => {
    let now = 1_000_000;
    const deps = { ...setup(), now: () => now };
    const snapshot = listModelCandidates({ need: "writing-code" }, deps);
    now += 6 * 60_000; // vencido
    // outra listagem dispara a poda, mas a carência preserva o id antigo
    listModelCandidates({ need: "analysis" }, deps);
    expect(() => resolveModelChoice(snapshot.snapshot_id, undefined, deps)).toThrow(CandidateSetChangedError);
  });

  test("snapshot vazio usa no_candidates e ranking empty", () => {
    const deps = setup();
    const snapshot = listModelCandidates({ need: "writing-code", requires: ["vision"] }, deps);
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.ranking).toBe("empty");
    let caught: unknown;
    try {
      resolveModelChoice(snapshot.snapshot_id, undefined, deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "no_candidates" });
  });

  test("cooldown real do provider exclui e health invalida snapshot", () => {
    const deps = setup();
    const before = listModelCandidates({ need: "writing-code", requires: ["tools"] }, deps);
    expect(before.candidates.some((c) => c.model.startsWith("p2/"))).toBe(true);

    markProviderFailure("p2", "outage");
    const cooled = listModelCandidates({ need: "writing-code", requires: ["tools"] }, deps);
    expect(cooled.candidates.every((c) => !c.model.startsWith("p2/"))).toBe(true);
    expect(() => resolveModelChoice(before.snapshot_id, undefined, deps)).toThrow(CandidateSetChangedError);

    markProviderSuccess("p2");
    expect(listModelCandidates({ need: "writing-code", requires: ["tools"] }, deps)
      .candidates.some((c) => c.model.startsWith("p2/"))).toBe(true);
  });

  test("cooldown recebe identidade composta e profile", () => {
    const seen: Array<{ model: string; profile?: string; provider: string }> = [];
    const snapshot = listModelCandidates(
      { need: "writing-code", requires: ["tools"] },
      { ...setup(), cooldown: (candidate) => { seen.push(candidate); return false; } },
    );
    expect(snapshot.candidates.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ model: "p1/cheap", profile: "fast", provider: "p1" });
  });

  test("quota esgotada e budget curto excluem", () => {
    const quotaDeps = setup(config({ quota: { p2: { dailyTokens: 1 } } }));
    quotaDeps.ledger.record({
      run: "r0", agent: "a", provider: "p2", model: "m", quotaDomain: "p2",
      tokensIn: 1, tokensOut: 1,
    });
    const byQuota = listModelCandidates({ need: "writing-code", requires: ["tools"], estimatedInputTokens: 8192 }, quotaDeps);
    expect(byQuota.candidates.every((c) => !c.model.startsWith("p2/"))).toBe(true);

    const budgetDeps = setup(config({ budget: { scope: "day", limitUsd: 0.01, warnAt: 0.8, onExceed: "stop" } }));
    const byBudget = listModelCandidates({ need: "writing-code", requires: ["tools"], estimatedInputTokens: 8192 }, budgetDeps);
    expect(byBudget.candidates.map((c) => c.model)).toEqual(["p1/cheap", "p2/noprice"]);
  });

  test("sem preço: ranking.no_price e eficiência desempata", () => {
    const cfg = config({
      models: [
        { provider: "p1", id: "a", tags: ["writing-code"], context: 8192, efficiency: 0.2 },
        { provider: "p1", id: "b", tags: ["writing-code"], context: 8192, efficiency: 0.9 },
      ],
      modelPool: { a: { model: "p1/a" }, b: { model: "p1/b" } },
      agent: { model: "p1/a", maxSteps: 2, tools: [] },
    });
    const snapshot = listModelCandidates({ need: "writing-code" }, setup(cfg));
    expect(snapshot.ranking).toBe("no_price");
    expect(snapshot.candidates.map((c) => c.profile)).toEqual(["b", "a"]);
  });

  test("snapshot: default_rank, escolha explícita e modelo fora", () => {
    const deps = setup();
    const snapshot = listModelCandidates({ need: "writing-code", requires: ["tools"], estimatedInputTokens: 8192 }, deps);
    const chosen = resolveModelChoice(snapshot.snapshot_id, undefined, deps);
    expect(chosen.reason).toBe("default_rank");
    expect(chosen.candidate.model).toBe(snapshot.candidates[0]!.model);

    const explicit = resolveModelChoice(snapshot.snapshot_id, "p2/noprice", deps);
    expect(explicit.candidate.model).toBe("p2/noprice");
    expect(explicit.reason).toContain("explicit_choice");

    expect(() => resolveModelChoice(snapshot.snapshot_id, "p1/ghost", deps)).toThrow(/invalid_model_choice|fora do snapshot/);
  });

  test("snapshot expira em 5 min e health invalida com a lista nova", () => {
    let now = 1_000_000;
    const deps = { ...setup(), now: () => now };
    const snapshot = listModelCandidates({ need: "writing-code" }, deps);

    now += 5 * 60_000 - 1;
    expect(resolveModelChoice(snapshot.snapshot_id, undefined, deps).reason).toBe("default_rank");
    now += 2;
    expect(() => resolveModelChoice(snapshot.snapshot_id, undefined, deps)).toThrow(CandidateSetChangedError);

    const fresh = listModelCandidates({ need: "writing-code" }, deps);
    markModelHealthChanged();
    let caught: unknown;
    try {
      resolveModelChoice(fresh.snapshot_id, undefined, deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CandidateSetChangedError);
    expect((caught as CandidateSetChangedError).snapshot.candidates.length).toBeGreaterThan(0);
  });

  test("tool list_model_candidates devolve o snapshot e valida a entrada", async () => {
    const deps = setup();
    const tool = createListModelCandidatesTool(() => deps);
    const ctx = { cwd: "/tmp", run: "r1", agent: "a" } as never;

    const result = await tool.execute({ need: "writing-code", requires: ["tools"] }, ctx);
    const snapshot = JSON.parse(result.output) as { candidates: unknown[]; snapshot_id: string; ranking: string };
    expect(snapshot.candidates.length).toBeGreaterThan(0);
    expect(snapshot.snapshot_id).toHaveLength(64);
    expect(["cost", "no_price"]).toContain(snapshot.ranking);

    await expect(tool.execute({ need: "chef" }, ctx)).rejects.toMatchObject({ code: "invalid_need" });
    await expect(tool.execute({ need: "writing-code", requires: ["quantum"] }, ctx)).rejects.toMatchObject({ code: "invalid_requires" });
    await expect(tool.execute({ need: "writing-code", estimatedInputTokens: -1 }, ctx)).rejects.toThrow(/estimatedInputTokens/);
  });

  test("escolha grava reason no evento agent.created (M3, ≤200)", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "worker", session_id: "r1", provider: "p1", model: "cheap", profile: "fast",
      credentialRef: "KEY1", reason: "default_rank",
    });
    const created = ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "created");
    expect(created).toMatchObject({ agent_id: "worker", model: "cheap", profile: "fast", reason: "default_rank" });
  });
});
