import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { CompactionPausedError, recordCompactionFailure } from "../src/compaction/breaker";
import { Ledger } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { AgentEntry, ModelEntry } from "../src/registry";
import { runMultiAgentSession } from "../src/session";
import { handoffTool } from "../src/tools/handoff";
import { ToolExecutor } from "../src/tools/executor";

interface Body {
  tools?: unknown[];
  messages?: Array<{ role?: string; content?: string }>;
}

function server(handler: (calls: number, body: Body) => Response) {
  let calls = 0;
  const bodies: Body[] = [];
  const instance = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as Body;
      bodies.push(body);
      return handler(calls, body);
    },
  });
  return { instance, bodies, calls: () => calls };
}

function writeConfig(dir: string, port: number, extra: Record<string, unknown> = {}): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 400 }],
    agent: { model: "mock/m1", maxSteps: 4, tools: [], systemPrompt: "SYS-PROMPT" },
    compaction: { buffer: 100 },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...extra,
  }));
  return path;
}

const ok = (content: string): Response => Response.json({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const toolCall = (name: string, args: object): Response => Response.json({
  choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
    function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const resp = (p: Partial<CompletionResponse> = {}): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

describe("compactação na sessão (S-17, CMP-8)", () => {
  test("cruza o gatilho com histórico, resume sem tools e continua preservando o system", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-session-"));
    writeFileSync(join(cwd, "AGENTS.md"), "REGRAS DO PROJETO");
    const mock = server((calls) => ok(calls === 1 ? "resumo do histórico" : "concluído"));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 24_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [], systemPrompt: "SYS-PROMPT" },
        compaction: { buffer: null },
      });
      const report = await runTask({
        configPath, task: "tarefa", cwd, env: { KEY: "k" },
        history: [
          { role: "user", content: "a".repeat(40_000) },
          { role: "assistant", content: "b".repeat(40_000) },
        ],
      });

      expect(report.final).toBe("concluído");
      expect(mock.calls()).toBe(2);

      const summary = mock.bodies[0]!;
      expect(summary.tools).toBeUndefined();
      expect(summary.messages?.[0]?.content).toContain("Resuma");

      const completion = mock.bodies[1]!;
      // CMP-8: AGENTS.md volta ao contexto depois de compactar.
      expect(completion.messages?.[0]?.content).toContain("REGRAS DO PROJETO");
      expect(completion.messages?.[0]?.content).toContain("SYS-PROMPT");
      expect(completion.messages?.[1]?.content).toContain("CompactionArtifactV1");
      // CMP-3: a parte recente começa no usuário, nunca num tool result órfão.
      expect(completion.messages?.[2]?.role).toBe("user");

      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction")).toHaveLength(1);
      expect(ledger.readAllEntries().find((entry) => entry.kind === "compaction"))
        .toMatchObject({ failure_count: 0, manual: false });
      // O uso do resumo também entra no ledger (custo/quota).
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "usage")).toHaveLength(2);
    } finally {
      mock.instance.stop(true);
    }
  });

  test("breaker pausado interrompe o run com a mensagem do CMP-6", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-paused-"));
    mkdirSync(join(cwd, ".astro"), { recursive: true });
    const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
    for (let index = 0; index < 3; index++) recordCompactionFailure(ledger, "r-paused", "default");

    const mock = server(() => ok("não deveria chamar"));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!);
      const error = await runTask({
        configPath, task: "x".repeat(1_200), cwd, env: { KEY: "k" }, runId: "r-paused",
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(CompactionPausedError);
      expect((error as Error).message).toMatch(/^Compaction paused \(3 failures, retry in \d+s\)$/);
      expect(mock.calls()).toBe(0);
      expect(ledger.lastState("r-paused")).toMatchObject({ state: "interrupted", reason: "compaction_paused" });
    } finally {
      mock.instance.stop(true);
    }
  });

  test("pausa após handoff não grava handoff.failed (retomável)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-handoff-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    for (let index = 0; index < 3; index++) recordCompactionFailure(ledger, "r1", "planner");

    const model: ModelEntry = {
      provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 24_000, status: "active",
    };
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: [] },
    };
    const registry = {
      requireAgent: (name: string) => agents[name] as AgentEntry,
      getAgent: (name: string) => agents[name],
      listAgentNames: () => Object.keys(agents),
    };
    let calls = 0;
    // Handoff com task grande: o receptor herda ~10k tokens e dispara o gatilho.
    const provider: Provider = {
      complete: async () => {
        calls++;
        return resp({ toolCalls: [{ id: "h1", name: "handoff", arguments: JSON.stringify({
          to: "coder",
          task: "x".repeat(40_000),
          objective: "o",
          decisions: [],
          constraints: [],
          next_steps: [],
        }) }] });
      },
    };

    const error = await runMultiAgentSession({
      run: "r1", credentialRef: "K", quotaDomain: "d", cwd, provider, registry,
      baseModel: model, baseExecutor: new ToolExecutor({
        tools: [handoffTool], allow: ["handoff"], audit,
      }),
      ledger, audit, baseMaxSteps: 3, entryAgent: "planner", compaction: { buffer: null },
    }, "plan").then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompactionPausedError);
    expect(calls).toBe(1); // o receptor nem chama o provider
    const events = ledger.readAllEntries()
      .map((entry) => (entry as { kind?: string }).kind)
      .filter((kind): kind is string => typeof kind === "string" && kind.startsWith("handoff."));
    expect(events).toContain("handoff.received");
    expect(events).not.toContain("handoff.failed");
    expect(ledger.lastState("r1")).toMatchObject({ state: "interrupted", reason: "compaction_paused" });
  });

  test("rejeição por tamanho compacta e retenta uma vez (CMP-7)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-overflow-"));
    const mock = server((calls) => {
      if (calls === 1) return Response.json({ error: { message: "maximum context length exceeded" } }, { status: 400 });
      if (calls === 2) return ok("resumo");
      return ok("concluído");
    });
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 128_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [] },
        compaction: { buffer: null },
      });
      const history = [
        { role: "user" as const, content: "a".repeat(40_000) },
        { role: "assistant" as const, content: "b".repeat(40_000) },
      ];
      const report = await runTask({ configPath, task: "oi", cwd, env: { KEY: "k" }, history });

      expect(report.final).toBe("concluído");
      expect(mock.calls()).toBe(3);
      expect(mock.bodies[1]!.tools).toBeUndefined(); // o resumo não expõe tools
      expect(mock.bodies[2]!.messages?.[1]?.content).toContain("CompactionArtifactV1");
    } finally {
      mock.instance.stop(true);
    }
  });

  test("segunda rejeição por tamanho encerra com erro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-overflow2-"));
    const mock = server((calls) => calls === 2
      ? ok("resumo")
      : Response.json({ error: { message: "maximum context length exceeded" } }, { status: 400 }));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!, {
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 128_000 }],
        agent: { model: "mock/m1", maxSteps: 3, tools: [] },
        compaction: { buffer: null },
      });
      const history = [
        { role: "user" as const, content: "a".repeat(40_000) },
        { role: "assistant" as const, content: "b".repeat(40_000) },
      ];
      const error = await runTask({ configPath, task: "oi", cwd, env: { KEY: "k" }, history })
        .then(() => null, (caught: unknown) => caught);

      expect(error).toBeDefined();
      expect((error as Error).message).toMatch(/maximum context length/);
      expect(mock.calls()).toBe(3);
    } finally {
      mock.instance.stop(true);
    }
  });
});
