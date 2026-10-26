import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit"; import { Ledger } from "../src/ledger";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor"; import { handoffTool } from "../src/tools/handoff";
import type { HandoffDraft } from "../src/handoff/types";

const models: Record<string, ModelEntry> = {
  "openai/gpt-4o": { provider: "openai", id: "gpt-4o", tags: ["writing-code"], context: 128000, status: "active" },
  "openai/gpt-4o-mini": { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active" },
};
const pool: Record<string, string> = { premium: "openai/gpt-4o", cheap: "openai/gpt-4o-mini" };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const draft: HandoffDraft = { task: "implementar login", objective: "ter login funcionando", decisions: [], constraints: [], next_steps: [] };
const handoffCall = () => resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: JSON.stringify({ to: "coder", ...draft }) }] });
const agents: Record<string, AgentEntry> = {
  planner: { model: "openai/gpt-4o-mini", profile: "premium", maxSteps: 10, tools: ["handoff"] },
  coder: { model: "openai/gpt-4o-mini", profile: "cheap", maxSteps: 10, tools: [] },
};
/** Resolução profile -> ModelEntry (ADR-0007): profile substitui model. */
const resolveModel = (a: AgentEntry): ModelEntry => {
  const key = a.profile === undefined ? a.model : pool[a.profile];
  if (key === undefined || models[key] === undefined) throw new Error(`profile "${a.profile ?? a.model}" não encontrado na pool`);
  return models[key]!;
};
function opts(cwd: string, provider: Provider, over: Partial<MultiAgentSessionOptions> = {}): MultiAgentSessionOptions {
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  return { run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
    registry: { requireAgent: (n) => agents[n] as AgentEntry, getAgent: (n) => agents[n], listAgentNames: () => Object.keys(agents), resolveModel },
    baseModel: models["openai/gpt-4o-mini"]!,
    baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
    ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner", ...over };
}
const modelSequence = async () => {
  const requests: CompletionRequest[] = [];
  const provider: Provider = { complete: async (req) => { requests.push(req); return requests.length === 1 ? handoffCall() : resp({ content: "done" }); } };
  const o = opts(mkdtempSync(join(tmpdir(), "astro-f29-")), provider);
  const result = await runMultiAgentSession(o, "plan");
  expect(result.final).toBe("done");
  return { requests: requests.map((r) => r.model), profiles: requests.map((r) => r.profile), ledger: o.ledger };
};

describe("runtime resolve profile por agente (F-29)", () => {
  test("sessão resolve o model via profile e o handoff resolve o receptor antes do swap", async () => {
    const first = await modelSequence();
    expect(first.requests).toEqual(["gpt-4o", "gpt-4o-mini"]); // planner via pool, receptor resolvido no swap
    expect(first.profiles).toEqual(["premium", "cheap"]); // F-31: profile vai na requisição
    const usage = first.ledger.readAll();
    expect(usage[0]).toMatchObject({ profile: "premium", model: "gpt-4o", agent: "planner" });
    expect(usage[1]).toMatchObject({ profile: "cheap", model: "gpt-4o-mini", agent: "coder" });
    const created = first.ledger.readHandoffs().find((e) => e.kind === "handoff.created")!;
    expect(created.artifact.from_profile).toBe("premium");
    expect(created.artifact.to_profile).toBe("cheap");
    const second = await modelSequence(); // determinismo: mesma config, mesmo modelo (I-06)
    expect(second.requests).toEqual(first.requests);
  });

  test("profile desconhecido do receptor falha antes do created e do swap", async () => {
    const bad: Record<string, AgentEntry> = { ...agents, coder: { model: "openai/gpt-4o-mini", profile: "ghost", maxSteps: 10, tools: [] } };
    const cwd = mkdtempSync(join(tmpdir(), "astro-f29-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const provider: Provider = { complete: async () => handoffCall() };
    const o: MultiAgentSessionOptions = { run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
      registry: { requireAgent: (n) => bad[n] as AgentEntry, getAgent: (n) => bad[n], listAgentNames: () => Object.keys(bad), resolveModel },
      baseModel: models["openai/gpt-4o-mini"]!, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
      ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner" };
    const err = await runMultiAgentSession(o, "plan").then(() => null, (e) => e as Error);
    expect(err?.message).toContain("ghost");
    expect(o.ledger.readHandoffs()).toHaveLength(0); // nada gravado: falha antes do created
  });

  test("compat: registry sem resolveModel usa baseModel; agent sem profile usa model direto", async () => {
    const plain: Record<string, AgentEntry> = { planner: { model: "openai/gpt-4o", maxSteps: 10, tools: ["handoff"] }, coder: { model: "openai/gpt-4o", maxSteps: 10, tools: [] } };
    const cwd = mkdtempSync(join(tmpdir(), "astro-f29-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const requests: CompletionRequest[] = [];
    const provider: Provider = { complete: async (req) => { requests.push(req); return requests.length === 1 ? handoffCall() : resp({ content: "done" }); } };
    const o: MultiAgentSessionOptions = { run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
      registry: { requireAgent: (n) => plain[n] as AgentEntry, getAgent: (n) => plain[n], listAgentNames: () => Object.keys(plain) },
      baseModel: models["openai/gpt-4o-mini"]!, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
      ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner" };
    const result = await runMultiAgentSession(o, "plan");
    expect(result.final).toBe("done");
    expect(requests.map((r) => r.model)).toEqual(["gpt-4o-mini", "gpt-4o-mini"]); // fallback compatível
    for (const entry of o.ledger.readAll()) expect("profile" in entry && entry.profile !== undefined).toBe(false); // sem profile no ledger
  });
});
