/**
 * Circuit breaker de compactação (CMP-6): 3 falhas consecutivas pausam por
 * 5 minutos; o contador vive no ledger e sobrevive ao `--resume`.
 */
import type { Ledger, LedgerCompactionEntry } from "../ledger";

export const COMPACTION_FAILURE_LIMIT = 3;
export const COMPACTION_PAUSE_MS = 5 * 60_000;

export interface CompactionState {
  failures: number;
  /** true quando o breaker está aberto (pausado). */
  paused: boolean;
  /** Milissegundos restantes de pausa (0 quando não pausado). */
  remainingMs: number;
}

/** Erro de compactação pausada; a mensagem é a do CMP-6. */
export class CompactionPausedError extends Error {
  readonly code = "compaction_paused";
  readonly remainingMs: number;

  constructor(remainingMs: number) {
    super(`Compaction paused (${COMPACTION_FAILURE_LIMIT} failures, retry in ${Math.ceil(remainingMs / 1000)}s)`);
    this.name = "CompactionPausedError";
    this.remainingMs = remainingMs;
  }
}

function lastFor(ledger: Ledger, run: string): { failures: number; ts: string } | undefined {
  const entry = ledger.readAllEntries()
    .filter((item): item is LedgerCompactionEntry => item.kind === "compaction" && item.run === run)
    .at(-1);
  return entry === undefined ? undefined : { failures: entry.failure_count, ts: entry.ts };
}

/** Estado derivado do último evento `compaction` do run. */
export function compactionState(ledger: Ledger, run: string, now = Date.now()): CompactionState {
  const last = lastFor(ledger, run);
  if (last === undefined) return { failures: 0, paused: false, remainingMs: 0 };
  if (last.failures < COMPACTION_FAILURE_LIMIT) {
    return { failures: last.failures, paused: false, remainingMs: 0 };
  }
  const remainingMs = new Date(last.ts).getTime() + COMPACTION_PAUSE_MS - now;
  return remainingMs > 0
    ? { failures: last.failures, paused: true, remainingMs }
    : { failures: last.failures, paused: false, remainingMs: 0 };
}

/** Registra falha; abre o breaker no limite. */
export function recordCompactionFailure(ledger: Ledger, run: string, agent: string): CompactionState {
  const failures = compactionState(ledger, run).failures + 1;
  ledger.recordCompaction({ run, agent, failure_count: failures, manual: false });
  return compactionState(ledger, run);
}

/** Registra sucesso (zera o contador). */
export function recordCompactionSuccess(ledger: Ledger, run: string, agent: string): void {
  ledger.recordCompaction({ run, agent, failure_count: 0, manual: false });
}

/** `/compact force`: zera o contador e marca `compaction.manual`. */
export function forceCompaction(ledger: Ledger, run: string, agent: string): void {
  ledger.recordCompaction({ run, agent, failure_count: 0, manual: true });
}
