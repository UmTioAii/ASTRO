import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { validateConfig, type AstroConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { listModelCandidates, resetCandidateSnapshots } from "../src/model-choice";
import { Registry } from "../src/registry";
import { createSpawnAgentTool, SpawnRegistry } from "../src/spawn";
import type { ToolContext } from "../src/tools/types";

function config(): AstroConfig {
  return validateConfig({
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
    },
    models: [
      { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, efficiency: 0.5,
        capabilities: { tools: true }, price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
      { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, efficiency: 0.4,
        capabilities: { tools: true }, price: { inputPerM: 2, outputPerM: 2, fonte: "t", verificado: false } },
    ],
    modelPool: { fast: { model: "p1/m1" }, smart: { model: "p2/m2" } },
    agent: { model: "p1/m1", maxSteps: 5, tools: ["handoff", "read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function setup(limit?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-spawn-"));
  const cfg = config();
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const registry = new Registry(cfg);
  const spawns = new SpawnRegistry(limit === undefined ? {} : { limit });
  writeFileSync(join(cwd, "AGENTS.md"), "Instruções do projeto");
  const tool = createSpawnAgentTool({ config: cfg, registry, ledger, audit, cwd, spawns, enabled: true });
  const ctx: ToolContext = { cwd, run: "r1", agent: "planner", allow: ["handoff", "read_file"], maxSteps: 3 };
  return { cwd, cfg, ledger, audit, registry, spawns, tool, ctx };
}

beforeEach(() => resetCandidateSnapshots());

describe("tool spawn_agent (S-11, A1/A2/A3/A5)", () => {
  test("cria subagente com modelo/profile da pool, escopo ⊆ pai e reason no ledger", async () => {
    const { ledger, spawns, tool, ctx } = setup();
    const result = await tool.execute({ need: "writing-code", task: "sub tarefa", tools: ["read_file"], maxTurns: 2 }, ctx);
    const body = JSON.parse(result.output) as { agent_id: string; model: string; profile?: string; status: string };

    expect(result.isError).toBe(false);
    expect(body).toMatchObject({ agent_id: "sub-1", model: "p1/m1", profile: "fast", status: "active" });
    expect(spawns.get("sub-1")?.tools).toEqual(["read_file"]);
    expect(spawns.get("sub-1")?.instructions).toBe("sub tarefa");

    const created = ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "created");
    expect(created).toMatchObject({
      agent_id: "sub-1", parent_agent_id: "planner", model: "m1", provider: "p1", profile: "fast",
      reason: "default_rank", need: "writing-code", snapshot_id: expect.any(String),
    });
  });

  test("sem conta livre o snapshot fica vazio; snapshot velho falha no lock", async () => {
    const { cfg, ledger, registry, tool, ctx } = setup();
    // Snapshot emitido antes de as contas serem presas.
    const snap = listModelCandidates({ need: "writing-code" }, { config: cfg, registry, ledger });
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);

    const stale = await tool.execute({ need: "writing-code", task: "d", model: "p1/m1", snapshot_id: snap.snapshot_id }, ctx);
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.output)).toMatchObject({ error: "account_locked" });

    expect((await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx)).isError).toBe(false);
    const third = await tool.execute({ need: "writing-code", task: "c", tools: [] }, ctx);
    expect(third.isError).toBe(true);
    expect(JSON.parse(third.output)).toMatchObject({ error: "spawn_limit_exceeded" });
  });

  test("limite de spawns por run dispara spawn_limit_exceeded", async () => {
    const { tool, ctx } = setup(1);
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);
    const second = await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.output)).toMatchObject({ error: "spawn_limit_exceeded" });
  });

  test("tools fora do pai e maxTurns maior que o pai são recusados", async () => {
    const { tool, ctx } = setup();
    const outside = await tool.execute({ need: "writing-code", task: "a", tools: ["run_command"] }, ctx);
    expect(outside.isError).toBe(true);
    expect(JSON.parse(outside.output)).toMatchObject({ error: "invalid_request" });

    const tooLong = await tool.execute({ need: "writing-code", task: "a", tools: [], maxTurns: 99 }, ctx);
    expect(tooLong.isError).toBe(true);
    expect(JSON.parse(tooLong.output)).toMatchObject({ error: "invalid_request" });
  });

  test("modelo fora do snapshot devolve invalid_model_choice com a lista", async () => {
    const { cfg, ledger, registry, tool, ctx } = setup();
    const snapshot = listModelCandidates({ need: "writing-code", requires: ["tools"] }, { config: cfg, registry, ledger });
    const result = await tool.execute({ need: "writing-code", task: "a", model: "p1/ghost", snapshot_id: snapshot.snapshot_id }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.output) as { error: string; candidates: unknown[] };
    expect(body.error).toBe("invalid_model_choice");
    expect(body.candidates.length).toBeGreaterThan(0);
  });

  test("subagente não spawna neto em v1 e snapshot com need divergente falha", async () => {
    const { cfg, ledger, registry, spawns, tool, ctx } = setup();
    const first = await tool.execute({ need: "writing-code", task: "a", tools: ["read_file"] }, ctx);
    expect(first.isError).toBe(false);

    const childCtx = { ...ctx, agent: "sub-1", allow: ["read_file", "spawn_agent"] };
    const nested = await tool.execute({ need: "writing-code", task: "b", tools: ["spawn_agent"] }, childCtx);
    expect(nested.isError).toBe(true);
    expect(JSON.parse(nested.output)).toMatchObject({ error: "invalid_request" });
    // Mesmo omitindo tools (default herdado), o filho não spawna.
    const inherited = await tool.execute({ need: "writing-code", task: "c" }, childCtx);
    expect(inherited.isError).toBe(true);
    expect(JSON.parse(inherited.output)).toMatchObject({ error: "invalid_request" });
    expect(spawns.size).toBe(1);

    const snapshot = listModelCandidates({ need: "writing-code", requires: ["tools"] }, { config: cfg, registry, ledger });
    const mismatch = await tool.execute({ need: "analysis", task: "b", model: "p1/m1", snapshot_id: snapshot.snapshot_id }, ctx);
    expect(mismatch.isError).toBe(true);
    expect(JSON.parse(mismatch.output)).toMatchObject({ error: "candidate_set_changed" });
  });

  test("sem candidato porque contas estão presas em outro run → no_candidates", async () => {
    const { ledger, audit, tool, ctx } = setup();
    for (const [provider, key] of [["p1", "KEY1"], ["p2", "KEY2"]] as const) {
      acquireAgentLock(ledger, audit, {
        run: "other", agent_id: `holder-${provider}`, session_id: "other", provider, credentialRef: key, accountRef: key,
      });
    }
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ error: "no_candidates" });
  });

  test("reason do chamador preserva o marcador da escolha", async () => {
    const { ledger, tool, ctx } = setup();
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], reason: "preciso de código" }, ctx);
    expect(result.isError).toBe(false);
    const created = ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "created");
    expect((created as { reason?: string }).reason).toMatch(/^default_rank: preciso de código/);
  });

  test("conta já presa por outro agente exclui o candidato e o spawn falha fechado", async () => {
    const { ledger, audit, tool, ctx } = setup();
    acquireAgentLock(ledger, audit, {
      run: "other", agent_id: "holder", session_id: "other", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
    });
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.output) as { model: string };
    expect(body.model).toBe("p2/m2"); // p1 preso; escolhe p2
  });
});
