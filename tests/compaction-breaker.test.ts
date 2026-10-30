import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import {
  COMPACTION_PAUSE_MS,
  CompactionPausedError,
  compactionState,
  forceCompaction,
  recordCompactionFailure,
  recordCompactionSuccess,
} from "../src/compaction/breaker";

function ledger(): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), "astro-compaction-breaker-")), "ledger.jsonl"));
}

describe("circuit breaker de compactação (S-17, CMP-6)", () => {
  test("3 falhas consecutivas pausam por 5 minutos com a mensagem do CMP-6", () => {
    const l = ledger();
    expect(recordCompactionFailure(l, "r1", "a").failures).toBe(1);
    expect(recordCompactionFailure(l, "r1", "a").failures).toBe(2);
    const state = recordCompactionFailure(l, "r1", "a");

    expect(state).toMatchObject({ failures: 3, paused: true });
    expect(state.remainingMs).toBeGreaterThan(COMPACTION_PAUSE_MS - 2_000);
    expect(state.remainingMs).toBeLessThanOrEqual(COMPACTION_PAUSE_MS);

    const error = new CompactionPausedError(state.remainingMs);
    expect(error.code).toBe("compaction_paused");
    expect(error.message).toMatch(/^Compaction paused \(3 failures, retry in \d+s\)$/);
  });

  test("a pausa vive no ledger e sobrevive a uma nova instância", () => {
    const path = join(mkdtempSync(join(tmpdir(), "astro-compaction-persist-")), "ledger.jsonl");
    const first = new Ledger(path);
    for (let index = 0; index < 3; index++) recordCompactionFailure(first, "r1", "a");

    const second = new Ledger(path);
    expect(compactionState(second, "r1").paused).toBe(true);
    expect(compactionState(second, "other-run").paused).toBe(false);
  });

  test("a pausa expira após 5 minutos", () => {
    const l = ledger();
    for (let index = 0; index < 3; index++) recordCompactionFailure(l, "r1", "a");
    expect(compactionState(l, "r1", Date.now() + COMPACTION_PAUSE_MS + 1_000).paused).toBe(false);
  });

  test("run id que o ledger redige continua vendo o próprio breaker", () => {
    const l = ledger();
    const run = "sk-abcdefgh12345678";
    for (let index = 0; index < 3; index++) recordCompactionFailure(l, run, "a");
    expect(compactionState(l, run)).toMatchObject({ failures: 3, paused: true });
  });

  test("sucesso zera o contador", () => {
    const l = ledger();
    recordCompactionFailure(l, "r1", "a");
    recordCompactionFailure(l, "r1", "a");
    recordCompactionSuccess(l, "r1", "a");
    expect(compactionState(l, "r1")).toMatchObject({ failures: 0, paused: false });
  });

  test("/compact force zera o contador e grava compaction.manual", () => {
    const l = ledger();
    for (let index = 0; index < 3; index++) recordCompactionFailure(l, "r1", "a");
    forceCompaction(l, "r1", "a");

    expect(compactionState(l, "r1")).toMatchObject({ failures: 0, paused: false });
    const last = l.readAllEntries().filter((entry) => entry.kind === "compaction").at(-1);
    expect(last).toMatchObject({ kind: "compaction", manual: true, failure_count: 0, run: "r1" });
  });
});
