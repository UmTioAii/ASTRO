/**
 * Circuit breaker de compactação (CMP-6): 3 falhas consecutivas pausam por
 * 5 minutos; o contador vive no ledger e sobrevive ao `--resume`. Stub RED.
 */
import type { Ledger } from "../ledger";

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

/** Estado derivado do último evento `compaction` do run. */
export function compactionState(_ledger: Ledger, _run: string, _now?: number): CompactionState {
  throw new Error("não implementado");
}

/** Registra falha; abre o breaker no limite. */
export function recordCompactionFailure(_ledger: Ledger, _run: string, _agent: string): CompactionState {
  throw new Error("não implementado");
}

/** Registra sucesso (zera o contador). */
export function recordCompactionSuccess(_ledger: Ledger, _run: string, _agent: string): void {
  throw new Error("não implementado");
}

/** `/compact force`: zera o contador e marca `compaction.manual`. */
export function forceCompaction(_ledger: Ledger, _run: string, _agent: string): void {
  throw new Error("não implementado");
}
