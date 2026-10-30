import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/app";
import { CompactionPausedError, recordCompactionFailure } from "../src/compaction/breaker";
import { Ledger } from "../src/ledger";

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
    agent: { model: "mock/m1", maxSteps: 3, tools: [], systemPrompt: "SYS-PROMPT" },
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

describe("compactação na sessão (S-17, CMP-8)", () => {
  test("cruza o gatilho, resume sem tools e continua a tarefa preservando o system", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-compaction-session-"));
    writeFileSync(join(cwd, "AGENTS.md"), "REGRAS DO PROJETO");
    const mock = server((calls) => ok(calls === 1 ? "resumo do histórico" : "concluído"));
    try {
      const configPath = writeConfig(cwd, mock.instance.port!);
      const report = await runTask({ configPath, task: "x".repeat(1_200), cwd, env: { KEY: "k" } });

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

      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction")).toHaveLength(1);
      expect(ledger.readAllEntries().find((entry) => entry.kind === "compaction"))
        .toMatchObject({ failure_count: 0, manual: false });
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
      });
      const report = await runTask({ configPath, task: "oi", cwd, env: { KEY: "k" } });

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
      });
      const error = await runTask({ configPath, task: "oi", cwd, env: { KEY: "k" } })
        .then(() => null, (caught: unknown) => caught);

      expect(error).toBeDefined();
      expect((error as Error).message).toMatch(/maximum context length/);
      expect(mock.calls()).toBe(3);
    } finally {
      mock.instance.stop(true);
    }
  });
});
