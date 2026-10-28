import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { SwapDeniedError } from "../src/approval";
import { scanHandoffs } from "../src/handoff/lifecycle";
import { buildHandoffArtifact } from "../src/handoff/types";
import { Ledger } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { handoffTool } from "../src/tools/handoff";

interface Seen { provider: string; model: string }

/** Providers a/b/c e agents planner(a/m1) → `handoffTo`; a faz handoff uma vez, depois responde. */
function setup(handoffTo = "coder", bFails = false) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-handoff-approval-"));
  const seen: Seen[] = [];
  const server = (provider: string, handoff: string | undefined, fail = false) => {
    let calls = 0;
    return Bun.serve({ port: 0, async fetch(req) {
      const model = ((await req.json()) as { model?: string }).model ?? "";
      seen.push({ provider, model });
      calls++;
      if (fail) return new Response("x", { status: 400 });
      if (handoff !== undefined && calls === 1) {
        return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "h1", type: "function", function: {
          name: "handoff",
          arguments: JSON.stringify({ to: handoff, task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }),
        } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      return Response.json({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
  };
  const a = server("a", handoffTo);
  const b = server("b", undefined, bFails);
  const c = server("c", undefined);
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: {
      a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${a.port}/v1`, credentialRef: "KEY_A" },
      b: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${b.port}/v1`, credentialRef: "KEY_B", fallback: ["c"] },
      c: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${c.port}/v1`, credentialRef: "KEY_C" },
    },
    models: [
      { provider: "a", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "b", id: "m2", tags: ["writing-code"], context: 8192 },
      { provider: "c", id: "m2", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: "a/m1", maxSteps: 4, tools: ["handoff"] },
    agents: {
      planner: { model: "a/m1", maxSteps: 2, tools: ["handoff"] },
      coder: { model: "b/m2", maxSteps: 2, tools: [] },
    },
    cache: { enabled: true, ttlHours: 1, maxEntries: 32 },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return {
    cwd, configPath, seen, env: { KEY_A: "a", KEY_B: "b", KEY_C: "c" },
    stop: () => { a.stop(true); b.stop(true); c.stop(true); },
    audit: () => new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll(),
    ledger: () => new Ledger(join(cwd, ".astro", "ledger.jsonl")),
  };
}

describe("gate de troca no handoff multi-agent (F-19, #161)", () => {
  test("sem aprovação: handoff fica pending, coder não executa", async () => {
    const { cwd, configPath, seen, env, stop, audit, ledger } = setup();
    try {
      await expect(runTask({ configPath, task: "x", cwd, env }))
        .rejects.toThrow(/troca não aprovada \(pending\)/);
      expect(seen).toEqual([{ provider: "a", model: "m1" }]); // coder (b/m2) não foi chamado
      const requested = audit().find((e) => e.tipo === "swap.requested");
      expect(requested?.payload).toMatchObject({ reason: "handoff", to: { provider: "b", model: "m2" } });
      expect(ledger().readStates().find((s) => s.state === "interrupted")?.reason).toBe("swap_denied");
    } finally {
      stop();
    }
  });

  test("com aprovação: coder executa no provider correto e audita o agente emissor", async () => {
    const { cwd, configPath, seen, env, stop, audit, ledger } = setup();
    try {
      const report = await runTask({ configPath, task: "x", cwd, env, approveSwap: () => true });
      expect(report.final).toBe("done");
      // Roteamento (F-31d): planner em a/m1, coder em b/m2 — não o provider de entrada
      expect(seen).toEqual([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]);
      const requested = audit().find((e) => e.tipo === "swap.requested");
      expect(requested).toMatchObject({ agent: "planner", payload: { reason: "handoff" } });
      expect(audit().some((e) => e.tipo === "swap.approved")).toBe(true);
      const acquiredB = audit().filter((e) => e.tipo === "credential.acquired"
        && (e.payload as { provider?: string }).provider === "b");
      expect(acquiredB.every((e) => e.agent === "coder")).toBe(true); // I-04 no multi-agent
      const usage = ledger().readAll().filter((e) => e.run === report.runId);
      expect(usage.find((e) => e.model === "m2")).toMatchObject({ provider: "b", credentialRef: "KEY_B" });
    } finally {
      stop();
    }
  });

  test("negação explícita: coder não executa e audit registra denied", async () => {
    const { cwd, configPath, seen, env, stop, audit } = setup();
    try {
      await expect(runTask({ configPath, task: "x", cwd, env, approveSwap: () => false }))
        .rejects.toThrow(/troca não aprovada \(denied\)/);
      expect(seen).toEqual([{ provider: "a", model: "m1" }]);
      const denied = audit().find((e) => e.tipo === "swap.denied");
      expect(denied).toMatchObject({ agent: "planner", payload: { reason: "handoff" } });
    } finally {
      stop();
    }
  });

  test("self-handoff com a mesma identidade não pede aprovação", async () => {
    const { cwd, configPath, seen, env, stop } = setup("planner");
    try {
      const report = await runTask({ configPath, task: "x", cwd, env,
        approveSwap: () => { throw new Error("não deveria pedir aprovação"); } });
      expect(report.final).toBe("done");
      expect(seen).toEqual([{ provider: "a", model: "m1" }, { provider: "a", model: "m1" }]);
    } finally {
      stop();
    }
  });

  test("swap por fallback dentro do agente é atribuído ao agente atual", async () => {
    const { cwd, configPath, seen, env, stop, audit } = setup("coder", true);
    try {
      const agents: string[] = [];
      const report = await runTask({ configPath, task: "x", cwd, env,
        approveSwap: (request) => { agents.push(request.agent ?? "?"); return true; } });
      expect(report.final).toBe("done");
      expect(agents).toEqual(["planner", "coder"]); // handoff e fallback b→c
      expect(seen.at(-1)).toEqual({ provider: "c", model: "m2" });
      const requested = audit().filter((e) => e.tipo === "swap.requested");
      expect(requested.map((e) => e.agent)).toEqual(["planner", "coder"]);
    } finally {
      stop();
    }
  });

  test("cache habilitado: 2ª execução reusa o planner e mantém gate/roteamento", async () => {
    const { cwd, configPath, seen, env, stop, audit } = setup();
    try {
      await runTask({ configPath, task: "x", cwd, env, approveSwap: () => true });
      expect(seen.filter((s) => s.provider === "a")).toHaveLength(1);
      const posts = seen.length;
      const report = await runTask({ configPath, task: "x", cwd, env, approveSwap: () => true });
      expect(report.final).toBe("done");
      expect(seen.filter((s) => s.provider === "a")).toHaveLength(1); // planner veio do cache
      expect(seen.length).toBe(posts + 1); // só o coder (artefato do handoff muda por run)
      expect(audit().some((e) => e.tipo === "cache.hit")).toBe(true);
    } finally {
      stop();
    }
  });

  test("negar o 2º handoff não invalida o 1º já recebido (I-19)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-handoff-2-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const model = (provider: string, id: string): ModelEntry =>
      ({ provider, id, tags: ["writing-code"], context: 8192, status: "active" });
    const models: Record<string, ModelEntry> = { "a/m1": model("a", "m1"), "b/m2": model("b", "m2"), "c/m3": model("c", "m3") };
    const agents: Record<string, AgentEntry> = {
      planner: { model: "a/m1", maxSteps: 2, tools: ["handoff"] },
      coder: { model: "b/m2", maxSteps: 2, tools: ["handoff"] },
      reviewer: { model: "c/m3", maxSteps: 2, tools: [] },
    };
    const handoff = (to: string): CompletionResponse => ({ content: "", toolCalls: [{ id: `h-${to}`, name: "handoff",
      arguments: JSON.stringify({ to, task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }) }],
      usage: { inputTokens: 1, outputTokens: 1 } });
    let calls = 0;
    const provider: Provider = { complete: async () => { calls++; return handoff(calls === 1 ? "coder" : "reviewer"); } };
    let gates = 0;
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "K", quotaDomain: "default", cwd, provider,
      registry: { requireAgent: (n) => agents[n]!, getAgent: (n) => agents[n], resolveModel: (a) => models[a.model]! },
      baseModel: models["a/m1"]!, baseExecutor: new ToolExecutor({ tools: [handoffTool], allow: ["handoff"], audit }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "planner",
      approveSwap: () => { gates++; return gates === 1; },
    };
    await expect(runMultiAgentSession(opts, "x")).rejects.toThrow(SwapDeniedError);
    expect(calls).toBe(2);
    const handoffs = scanHandoffs(ledger, "r1");
    expect(handoffs).toHaveLength(1); // 2º handoff nem foi criado (gate antes)
    expect(handoffs[0]!.state).not.toBe("failed"); // 1º continua válido
    expect(ledger.lastState("r1")?.reason).toBe("swap_denied");
  });

  test("retomada de handoff pendente também passa pelo gate", async () => {
    const { cwd, configPath, seen, env, stop, audit } = setup();
    try {
      mkdirSync(join(cwd, ".astro"), { recursive: true });
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      ledger.recordAgentCreated({ run: "r1", agent_id: "planner", session_id: "r1", model: "m1" });
      ledger.recordState("r1", "interrupted", { agent: "planner", reason: "cancelled" });
      const artifact = buildHandoffArtifact({
        run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 },
        sourceRefs: { ledger_id: ledger.id(), seq_start: 1, seq_end: 1 },
        draft: { task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] },
      });
      ledger.recordHandoff("handoff.created", "r1", artifact, { agent: "planner" });

      await expect(runTask({ configPath, task: "x", cwd, env, resume: "r1", approveSwap: () => false }))
        .rejects.toThrow(/troca não aprovada \(denied\)/);
      expect(seen).toEqual([]); // nem planner nem coder executam antes do gate
      expect(audit().some((e) => e.tipo === "swap.denied")).toBe(true);
    } finally {
      stop();
    }
  });
});
