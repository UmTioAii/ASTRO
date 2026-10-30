/**
 * Runtime da compactação (S-17, CMP-6/CMP-7): decide quando compactar antes da
 * chamada, retenta UMA vez quando o provider rejeita por tamanho e respeita a
 * pausa do breaker.
 */
import { throwIfAborted, isAbortError } from "../abort";
import type { Auditor } from "../audit";
import type { Ledger } from "../ledger";
import { ProviderError, type ChatMessage, type CompletionResponse } from "../provider/types";
import {
  CompactionPausedError,
  compactionState,
  recordCompactionFailure,
  recordCompactionSuccess,
} from "./breaker";
import {
  RECENT_TOKENS,
  compactSession,
  effectiveRecentBudget,
  recentSliceStart,
  reserveTokens,
  shouldCompact,
  type CompactionConfig,
} from "./engine";
import { countMessageTokens } from "../tokens";

export interface CompactionRuntimeOptions {
  ledger: Ledger;
  audit: Auditor;
  run: string;
  agent: () => string;
  window: () => number;
  provider: () => string;
  model: () => string;
  compaction: CompactionConfig;
  signal?: AbortSignal;
  /** Completion real sobre as mensagens correntes. */
  complete: (messages: readonly ChatMessage[]) => Promise<CompletionResponse>;
  /** Resumo sem tools. */
  summarize: (messages: ChatMessage[]) => Promise<string>;
  /** Chamado após uma compactação aplicada (ex.: atualizar histórico do agente). */
  onCompacted?: (messages: readonly ChatMessage[]) => void;
}

/** Vocabulário de tamanho/estouro; "context caching" não é overflow. */
const OVERFLOW_PATTERN = /context\s*(length|window)|maximum.{0,24}(token|context)|prompt is too (large|long)|too many tokens|token.{0,24}(limit|maximum)|exceeds?.{0,12}context/i;

/** O provider rejeitou por tamanho de contexto? */
export function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.errClass !== "invalid_request") return false;
  return OVERFLOW_PATTERN.test(error.message);
}

type CompactReason = "trigger" | "overflow";

/** Overhead estimado do artefato no contexto compactado (tokens). */
const ARTIFACT_OVERHEAD = 500;

/** A compactação consegue projetar o contexto abaixo do gatilho? */
function projectionCanClear(messages: readonly ChatMessage[], opts: CompactionRuntimeOptions): boolean {
  const window = opts.window();
  const start = recentSliceStart(messages, effectiveRecentBudget(window, opts.compaction.buffer));
  const older = start - (messages[0]?.role === "system" ? 1 : 0);
  if (older <= 0) return false;
  const recentTokens = countMessageTokens(messages.slice(start), { provider: opts.provider() }).tokens;
  return recentTokens + ARTIFACT_OVERHEAD < window - reserveTokens(window, opts.compaction.buffer);
}

/** Compacta, grava sucesso/falha e abre o breaker quando necessário. */
async function applyCompaction(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
  reason: CompactReason,
): Promise<boolean> {
  const state = compactionState(opts.ledger, opts.run);
  if (state.paused) throw new CompactionPausedError(state.remainingMs);
  // Sem histórico anterior ou sem projeção para sair do gatilho, repetir a cada
  // step só gastaria tokens de resumo sem reduzir o contexto.
  if (reason === "trigger" && !projectionCanClear(messages, opts)) return false;

  const agent = opts.agent();
  try {
    const result = await compactSession({
      run: opts.run,
      messages,
      window: opts.window(),
      buffer: opts.compaction.buffer,
      provider: opts.provider(),
      summarize: opts.summarize,
    });
    if (result.olderCount === 0) {
      // Nada anterior para substituir (ex.: primeira tarefa já grande): não há
      // compactação possível e repetir a cada step só gastaria tokens.
      return false;
    }
    messages.length = 0;
    messages.push(...result.messages);
    recordCompactionSuccess(opts.ledger, opts.run, agent);
    opts.onCompacted?.(messages);
    opts.audit.append({
      run: opts.run,
      agent,
      tipo: "compaction.applied",
      payload: {
        reason,
        reduction: result.reduction,
        originalTokens: result.originalTokens,
        returnedTokens: result.returnedTokens,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof CompactionPausedError) throw error;
    // Cancelamento não é falha de compactação: não conta no breaker (CMP-6).
    if (isAbortError(error, opts.signal)) throw error;
    const after = recordCompactionFailure(opts.ledger, opts.run, agent);
    opts.audit.append({
      run: opts.run,
      agent,
      tipo: "compaction.failed",
      payload: { reason, error: error instanceof Error ? error.name : "unknown" },
    });
    if (after.paused) throw new CompactionPausedError(after.remainingMs);
    // Gatilho: segue sem compactar (tenta de novo no próximo step). Overflow:
    // sem compactar não há como atender; propaga o erro original.
    if (reason === "overflow") throw error;
    return false;
  }
}

/** Compacta antes da chamada quando o gatilho dispara e retenta uma vez por overflow. */
export async function completeWithCompaction(
  messages: ChatMessage[],
  opts: CompactionRuntimeOptions,
): Promise<CompletionResponse> {
  throwIfAborted(opts.signal);

  if (shouldCompact(messages, opts.window(), opts.compaction.buffer, { provider: opts.provider() })) {
    await applyCompaction(messages, opts, "trigger");
    throwIfAborted(opts.signal);
  }

  try {
    return await opts.complete(messages);
  } catch (error) {
    if (!isContextOverflow(error)) throw error;
    await applyCompaction(messages, opts, "overflow");
    throwIfAborted(opts.signal);
    // Segunda rejeição é terminal (CMP-7): o erro sobe para a sessão.
    return await opts.complete(messages);
  }
}
