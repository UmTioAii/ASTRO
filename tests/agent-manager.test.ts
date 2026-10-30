import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { Registry } from "../src/registry";
import { AgentManager, formatAgentsList } from "../src/agent-manager";
import { assertAgentQuota } from "../src/team";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cfgRaw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  providers: {
    openai: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "X_KEY" },
    backup: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "BACKUP_KEY" },
  },
  models: [
    { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, capabilities: { tools: true } },
    { provider: "openai", id: "llama-3", tags: ["analysis"], context: 8192 },
  ],
  modelPool: { "cheap-explorer": { model: "openai/llama-3" } },
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: [] },
  agents: {
    coder: { model: "openai/gpt-4o-mini" },
    explorer: { profile: "cheap-explorer" },
  },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  ...over,
});

const dir = () => mkdtempSync(join(tmpdir(), "astro-agentmgr-"));

describe("AgentManager (F-28)", () => {
  test("create/list/destroy com eventos agent.created e agent.destroyed no audit", () => {
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const registry = new Registry(validateConfig(cfgRaw()));
    const m = new AgentManager({ registry, audit });

    const coder = m.create("coder", "r1");
    expect(coder).toEqual({ name: "coder", provider: "openai", model: "gpt-4o-mini" });
    const explorer = m.create("explorer", "r1");
    expect(explorer).toEqual({
      name: "explorer", profile: "cheap-explorer", provider: "openai", model: "llama-3",
    });

    expect(m.list().map((a) => a.name).sort()).toEqual(["coder", "explorer"]);
    m.destroy("coder", "r1");
    expect(m.list().map((a) => a.name)).toEqual(["explorer"]);

    const events = audit.readAll();
    const created = events.filter((e) => e.tipo === "agent.created");
    expect(created).toHaveLength(2);
    expect(created.find((e) => e.agent === "coder")!.payload).toEqual({
      name: "coder", provider: "openai", model: "gpt-4o-mini",
    });
    expect(created.find((e) => e.agent === "explorer")!.payload).toEqual({
      name: "explorer", profile: "cheap-explorer", provider: "openai", model: "llama-3",
    });
    const destroyed = events.filter((e) => e.tipo === "agent.destroyed");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].payload.name).toBe("coder");
    expect(destroyed[0].agent).toBe("coder");
  });

  test("erros de ciclo de vida: inexistente, duplicado, destruir inativo", () => {
    const audit = new Auditor(join(dir(), "audit.jsonl"));
    const registry = new Registry(validateConfig(cfgRaw()));
    const m = new AgentManager({ registry, audit });
    expect(() => m.create("fantasma", "r1")).toThrow(/fantasma/);
    m.create("coder", "r1");
    expect(() => m.create("coder", "r1")).toThrow(/ativo/);
    expect(() => m.destroy("explorer", "r1")).toThrow(/ativo/);
    // agent da config continua válido sem o manager (compat): registry intocado
    expect(registry.requireAgent("coder").model).toBe("openai/gpt-4o-mini");
  });

  test("orçamento por agente reusa team.agentQuotas existente (sem novo contador)", () => {
    const ledger = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    ledger.record(
      { run: "r1", agent: "explorer", provider: "openai", model: "llama-3", credentialRef: "X_KEY", quotaDomain: "default", tokensIn: 5000, tokensOut: 10 },
      price,
    );
    expect(() => assertAgentQuota(ledger, { explorer: { dailyTokens: 1000 } }, "explorer")).toThrow(/explorer/);
    expect(() => assertAgentQuota(ledger, { explorer: { dailyTokens: 10_000 } }, "explorer")).not.toThrow();
  });
});

describe("formatAgentsList e CLI (F-28)", () => {
  test("linhas com nome, profile e modelo resolvido; sem agents, mensagem clara", () => {
    const out = formatAgentsList(validateConfig(cfgRaw()));
    expect(out).toContain("coder");
    expect(out).toContain("openai/gpt-4o-mini");
    expect(out).toContain("explorer");
    expect(out).toContain("cheap-explorer");
    expect(out).toContain("openai/llama-3");
    expect(formatAgentsList(validateConfig(cfgRaw({ agents: undefined })))).toContain("nenhum agent");
  });

  test("bun src/cli.ts agents list imprime os agents nomeados", async () => {
    const cwd = dir();
    const cfgPath = join(cwd, "astro.config.json");
    writeFileSync(cfgPath, JSON.stringify(cfgRaw()), "utf8");
    const proc = Bun.spawn(["bun", "src/cli.ts", "agents", "list", "--config", cfgPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(exit).toBe(0);
    expect(out).toContain("coder");
    expect(out).toContain("explorer");
    expect(out).toContain("openai/llama-3");
  });
});
