import { describe, expect, test } from "bun:test";
import type { AstroConfig } from "../src/config";
import { validateConfig } from "../src/config";
import { Registry } from "../src/registry";

const cfg: AstroConfig = validateConfig({
  providers: {
    openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" },
    backup: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "BACKUP_API_KEY" },
  },
  models: [
    { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 },
    { provider: "openai", id: "old-model", tags: ["fast"], context: 8192, status: "deprecated" },
  ],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file", "write_file", "run_command"] },
  agents: {
    planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["read_file"], systemPrompt: "Planeje" },
    coder: { model: "openai/gpt-4o-mini", maxSteps: 15, tools: ["read_file", "write_file", "run_command"] },
  },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});

test("get devolve por chave provider/id (qualquer status)", () => {
  const r = new Registry(cfg);
  expect(r.get("openai/gpt-4o-mini")?.id).toBe("gpt-4o-mini");
  expect(r.get("openai/old-model")?.status).toBe("deprecated");
  expect(r.get("openai/ghost")).toBeUndefined();
});

test("require exige status active", () => {
  const r = new Registry(cfg);
  expect(r.require("openai/gpt-4o-mini").id).toBe("gpt-4o-mini");
  expect(() => r.require("openai/old-model")).toThrow(/active|old-model/);
  expect(() => r.require("openai/ghost")).toThrow(/openai\/ghost/);
});

test("list devolve só active e filtra por tag", () => {
  const r = new Registry(cfg);
  expect(r.list().map((m) => m.id)).toEqual(["gpt-4o-mini"]);
  expect(r.list({ tags: ["tools"] }).map((m) => m.id)).toEqual(["gpt-4o-mini"]);
  expect(r.list({ tags: ["nonexistent"] })).toEqual([]);
});

describe("agents (F3-1)", () => {
  test("getAgent devolve agent nomeado", () => {
    const r = new Registry(cfg);
    expect(r.getAgent("planner")?.maxSteps).toBe(10);
    expect(r.getAgent("planner")?.tools).toEqual(["read_file"]);
    expect(r.getAgent("planner")?.systemPrompt).toBe("Planeje");
    expect(r.getAgent("ghost")).toBeUndefined();
  });

  test("requireAgent exige agent existente", () => {
    const r = new Registry(cfg);
    expect(r.requireAgent("coder").maxSteps).toBe(15);
    expect(r.requireAgent("coder").tools).toEqual(["read_file", "write_file", "run_command"]);
    expect(() => r.requireAgent("ghost")).toThrow(/agent.*não encontrado/);
  });

  test("listAgents devolve todos agents", () => {
    const r = new Registry(cfg);
    const agents = r.listAgents();
    expect(agents.map((a) => a.maxSteps)).toEqual([10, 15]);
    expect(agents.length).toBe(2);
  });

  test("config sem agents retorna vazio", () => {
    const cfgNoAgents = validateConfig({
      providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
      models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
      agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });
    const r = new Registry(cfgNoAgents);
    expect(r.getAgent("planner")).toBeUndefined();
    expect(() => r.requireAgent("planner")).toThrow(/agent.*não encontrado/);
    expect(r.listAgents()).toEqual([]);
  });
});
