import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Auditor } from "../src/audit"; import { Ledger } from "../src/ledger";
import { buildHandoffArtifact, HandoffError, type HandoffDraft } from "../src/handoff/types";
import { formatHandoffShow, readSourceRefs } from "../src/handoff/lifecycle";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor"; import { handoffTool } from "../src/tools/handoff";

const model: ModelEntry = { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active" };
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const big = (n: number) => "x".repeat(n);
const dir = () => mkdtempSync(join(tmpdir(), "astro-f25b-"));
const agents: Record<string, AgentEntry> = { planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["handoff"] }, coder: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: [] } };
function opts(cwd: string, provider: Provider): MultiAgentSessionOptions {
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  return { run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider,
    registry: { requireAgent: (n) => agents[n] as AgentEntry, getAgent: (n) => agents[n], listAgentNames: () => Object.keys(agents) },
    baseModel: model, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
    ledger: new Ledger(join(cwd, "ledger.jsonl")), audit, baseMaxSteps: 5, entryAgent: "planner" };
}
const handoffArgs = (draft: HandoffDraft, artifacts?: string[]) => JSON.stringify({ to: "coder", ...draft, ...(artifacts === undefined ? {} : { artifacts }) });

describe("compactação integrada à sessão e ao comando (F-25)", () => {
  test("emissor compacta, grava refs/digests e o receptor recupera o detalhe", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "arte.txt"), "conteúdo do artefato");
    const draft: HandoffDraft = { task: "implementar login", objective: "ter login funcionando", decisions: ["usar sessão"], constraints: [], next_steps: ["testar"], open_questions: [big(3000)] };
    const requests: CompletionRequest[] = [];
    const provider: Provider = { complete: async (req) => {
      requests.push(req);
      return requests.length === 1 ? resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: handoffArgs(draft, ["arte.txt"]) }] }) : resp({ content: "ok" });
    } };
    const o = opts(cwd, provider);
    const result = await runMultiAgentSession(o, "plan");
    expect(result.final).toBe("ok");
    const created = o.ledger.readHandoffs().find((e) => e.kind === "handoff.created")!;
    expect(created.artifact.compaction).toEqual({ strategy: "truncate", droppedFields: ["open_questions"] });
    expect(created.artifact.truncated).toBe(true);
    expect(created.artifact.originalTokens).toBeGreaterThan(created.artifact.returnedTokens!);
    expect(created.artifact.artifacts![0]).toEqual({ path: "arte.txt", digest: sha("conteúdo do artefato") });
    expect(created.artifact.source_refs!.ledger_id).toBe(o.ledger.id());
    expect(created.artifact.source_refs!.seq_start).toBeLessThanOrEqual(created.artifact.source_refs!.seq_end);
    // receptor recebeu o nível compacto + a recuperação do intervalo de origem
    const artifactMsg = requests[1]!.messages.find((m) => m.content?.includes("[Sistema: handoff"))!.content!;
    expect(artifactMsg).toContain("recuperação");
    expect(artifactMsg).toContain("implementar login");
    expect(artifactMsg).not.toContain(big(50)); // open_questions cortado não vai ao receptor
  });

  test("draft pequeno vai sem corte: strategy none e sem recuperação", async () => {
    const cwd = dir();
    const requests: CompletionRequest[] = [];
    const provider: Provider = { complete: async (req) => {
      requests.push(req);
      return requests.length === 1 ? resp({ toolCalls: [{ id: "c1", name: "handoff", arguments: handoffArgs({ task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }) }] }) : resp({ content: "ok" });
    } };
    const o = opts(cwd, provider);
    await runMultiAgentSession(o, "plan");
    const created = o.ledger.readHandoffs().find((e) => e.kind === "handoff.created")!;
    expect(created.artifact.compaction).toEqual({ strategy: "none", droppedFields: [] });
    expect(created.artifact.truncated).toBeUndefined();
    expect(JSON.stringify(requests[1]!.messages)).not.toContain("recuperação");
  });

  test("digest divergente na retomada rejeita com handoff_artifact_mismatch", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "arte.txt"), "conteúdo alterado depois do handoff");
    const o = opts(cwd, { complete: async () => { throw new Error("receptor não deveria rodar"); } });
    const bad = buildHandoffArtifact({ run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 },
      draft: { task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }, artifacts: [{ path: "arte.txt", digest: "0".repeat(64) }] });
    o.ledger.recordHandoff("handoff.created", "r1", bad, { agent: "planner" });
    const err = await runMultiAgentSession(o, "plan").then(() => null, (e) => e as HandoffError);
    expect(err?.code).toBe("handoff_artifact_mismatch");
    expect(err?.retryable).toBe(false);
    expect(o.ledger.readHandoffs().filter((e) => e.kind === "handoff.received")).toHaveLength(0); // segue pending
  });

  test("readSourceRefs devolve o intervalo de origem; id estranho rejeita", () => {
    const cwd = dir();
    const o = opts(cwd, { complete: async () => resp({ content: "x" }) });
    o.ledger.record({ run: "r1", agent: "planner", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 10, tokensOut: 5, callHashes: [] });
    o.ledger.record({ run: "r2", agent: "planner", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 1, callHashes: [] });
    const refs = { ledger_id: o.ledger.id(), seq_start: 1, seq_end: 1 };
    const interval = readSourceRefs(o.ledger, refs);
    expect(interval).toHaveLength(1);
    expect(interval[0]!.run).toBe("r1"); // não vazou o run vizinho
    expect(() => readSourceRefs(o.ledger, { ...refs, ledger_id: "a".repeat(64) })).toThrow(HandoffError);
  });

  test("astro handoff show inspeciona o artefato com a auditoria da compactação", () => {
    const cwd = dir();
    const o = opts(cwd, { complete: async () => resp({ content: "x" }) });
    const artifact = buildHandoffArtifact({ run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 42, usd: 0.5 },
      draft: { task: "implementar login", objective: "ter login funcionando", decisions: [], constraints: [], next_steps: ["testar"], open_questions: ["?"] },
      artifacts: [{ path: "arte.txt", digest: sha("conteúdo") }],
      compaction: { strategy: "truncate", droppedFields: ["open_questions"] },
      truncation: { truncated: true, originalTokens: 120, returnedTokens: 30 } });
    o.ledger.recordHandoff("handoff.created", "r1", artifact, { agent: "planner" });
    const id = o.ledger.readHandoffs()[0]!.handoff_id;
    const out = formatHandoffShow(o.ledger, id);
    expect(out).toContain("handoff");
    expect(out).toContain("truncate (dropou: open_questions)");
    expect(out).toContain("truncado (120 → 30 tokens)");
    expect(out).toContain("arte.txt");
    expect(() => formatHandoffShow(o.ledger, "deadbeef")).toThrow(/não encontrado no ledger/);
  });
});
