/**
 * Motor de compactação de sessão (S-17, CMP-1..CMP-5, CMP-8): gatilho por
 * janela, parte recente, níveis de redução e artefato. O resumo é gerado por
 * um callback injetado que NUNCA expõe tools (CMP-4). Stub RED.
 */
import type { ChatMessage } from "../provider/types";
import type { CompactionArtifactV1 } from "./types";

/** Config `compaction` (D-CFG1): `buffer: null` usa o default do ADR-0015. */
export interface CompactionConfig {
  buffer: number | null;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = { buffer: null };

/** Parte recente preservada, em tokens (CMP-2). */
export const RECENT_TOKENS = 15_000;

/** Reserva da janela (CMP-1): max(15% da janela, 16.000) ou `buffer` explícito. */
export function reserveTokens(_window: number, _buffer?: number | null): number {
  throw new Error("não implementado");
}

/** A estimativa atingiu `window - reserve`? */
export function shouldCompact(
  _messages: readonly ChatMessage[],
  _window: number,
  _buffer?: number | null,
  _opts?: { provider?: string },
): boolean {
  throw new Error("não implementado");
}

/** Índice onde começa a parte recente: corte no início de mensagem de usuário. */
export function recentSliceStart(
  _messages: readonly ChatMessage[],
  _budget?: number,
): number {
  throw new Error("não implementado");
}

/** Nível de redução (1–5) e mensagens do histórico antigo para o resumo. */
export interface ReducedHistory {
  level: 1 | 2 | 3 | 4 | 5;
  messages: ChatMessage[];
}

/** Aplica um nível de redução (CMP-5) ao histórico antigo. */
export function applyReduction(_older: readonly ChatMessage[], _level: 1 | 2 | 3 | 4 | 5): ReducedHistory {
  throw new Error("não implementado");
}

export interface CompactInput {
  run: string;
  /** Histórico completo; a primeira mensagem é o system prompt. */
  messages: readonly ChatMessage[];
  window: number;
  buffer?: number | null;
  /** Modelo ativo para tokenizer nativo. */
  provider?: string;
  /** Resumo sem tools; recebe system de instrução + histórico reduzido. */
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

export interface CompactResult {
  /** system original + artefato + parte recente. */
  messages: ChatMessage[];
  artifact: CompactionArtifactV1;
  reduction: ReducedHistory["level"];
  originalTokens: number;
  returnedTokens: number;
}

/** Executa uma compactação: parte recente, redução do antigo, resumo e artefato. */
export async function compactSession(_input: CompactInput): Promise<CompactResult> {
  throw new Error("não implementado");
}
