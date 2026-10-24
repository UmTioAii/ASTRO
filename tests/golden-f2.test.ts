import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TASK = "crie hello.ts";
const SECRET = "test-key";
const TASK_HASH = /^[0-9a-f]{16}$/;
// 12+25 tokens de entrada e 6+10 de saída a US$ 2/M e US$ 4/M.
const RUN_COST = (37 / 1e6) * 2 + (16 / 1e6) * 4;

interface LedgerLine {
  run: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  kind?: string;
  state?: string;
}

interface AuditLine {
  run: string;
  tipo: string;
  payload: Record<string, unknown>;
}

/** Entradas de uso (tokens/custo); entradas de estado (F-02) ficam de fora. */
function readLedger(dir: string): LedgerLine[] {
  const text = readFileSync(join(dir, ".astro", "ledger.jsonl"), "utf8").trim();
  return text
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerLine)
    .filter((e) => e.kind !== "run_state");
}

/** Entradas de estado de execução gravadas pelo run (F-02). */
function readLedgerStates(dir: string): LedgerLine[] {
  const text = readFileSync(join(dir, ".astro", "ledger.jsonl"), "utf8").trim();
  return text
    .split("\n")
    .map((line) => JSON.parse(line) as LedgerLine)
    .filter((e) => e.kind === "run_state");
}

function readAudit(dir: string): { text: string; events: AuditLine[] } {
  const text = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
  const events = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditLine);
  return { text, events };
}

test("golden F2: tarefa de código ponta a ponta com custo e auditoria", async () => {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      call++;
      return Response.json(call % 2 === 1
        ? { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.ts", content: "export const hello = () => 'hi';\n" }) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 6 } }
        : { choices: [{ message: { content: "criei hello.ts" } }], usage: { prompt_tokens: 25, completion_tokens: 10 } });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "astro-golden-"));
  const cfgPath = join(dir, "astro.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 4096, price: { inputPerM: 2, outputPerM: 4, fonte: "teste", verificado: false } }],
    agent: { model: "mock/mock-1", maxSteps: 6, tools: ["write_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2));

  const runCli = async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "run", TASK, "--config", cfgPath, "--cwd", dir], {
      cwd: root,
      env: { ...process.env, TEST_KEY: SECRET } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { exit, stdout, stderr };
  };

  try {
    // Primeira execução: contrato da golden do plano.
    const first = await runCli();

    expect(first.exit).toBe(0);
    expect(first.stdout).toContain("criei hello.ts");
    expect(first.stderr).not.toContain(SECRET);
    expect(existsSync(join(dir, "hello.ts"))).toBe(true);

    const firstLedger = readLedger(dir);
    expect(firstLedger.length).toBeGreaterThanOrEqual(2);
    const firstCost = firstLedger.reduce((s, e) => s + (e.costUsd ?? 0), 0);
    expect(firstCost).toBeCloseTo(RUN_COST, 10);

    const firstAudit = readAudit(dir);
    expect(firstAudit.text).toContain("run.started");
    expect(firstAudit.text).toContain("run.completed");
    expect(`${first.stdout}${first.stderr}${firstAudit.text}${JSON.stringify(firstLedger)}`).not.toContain(SECRET);

    // I-04: o prompt não é persistido, apenas um hash curto de 16 hex.
    const firstStarted = firstAudit.events.filter((e) => e.tipo === "run.started");
    expect(firstStarted).toHaveLength(1);
    expect(firstStarted[0]?.payload.taskHash).toMatch(TASK_HASH);
    expect(firstAudit.text).not.toContain(TASK);

    // I-03: o valor da chave não aparece nem no arquivo de configuração.
    expect(readFileSync(cfgPath, "utf8")).not.toContain(SECRET);

    // Segunda execução no mesmo cwd: o custo reportado é o delta do run.
    const second = await runCli();

    expect(second.exit).toBe(0);
    expect(second.stdout).toContain("criei hello.ts");
    expect(second.stderr).not.toContain(SECRET);

    const ledgerAfter = readLedger(dir);
    const secondLedger = ledgerAfter.slice(firstLedger.length);
    expect(secondLedger).toHaveLength(2);
    const secondCost = secondLedger.reduce((s, e) => s + (e.costUsd ?? 0), 0);
    expect(secondCost).toBeCloseTo(RUN_COST, 10);

    // F-02: cada run registra o estado de execução no ledger
    const states = readLedgerStates(dir);
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.state === "completed")).toBe(true);

    const secondAudit = readAudit(dir);
    const startedRuns = secondAudit.events.filter((e) => e.tipo === "run.started");
    expect(startedRuns).toHaveLength(2);
    for (const started of startedRuns) {
      expect(started.payload.taskHash).toMatch(TASK_HASH);
    }
    expect(secondAudit.text).not.toContain(TASK);

    const secondRunId = secondLedger[0]?.run;
    expect(secondRunId).toBeDefined();
    const completed = secondAudit.events.find(
      (e) => e.tipo === "run.completed" && e.run === secondRunId,
    );
    expect(completed).toBeDefined();
    expect(completed?.payload.costUsd).toBeCloseTo(RUN_COST, 10);
    expect(
      `${second.stdout}${second.stderr}${secondAudit.text}${JSON.stringify(secondLedger)}`,
    ).not.toContain(SECRET);
  } finally {
    server.stop(true);
  }
});
