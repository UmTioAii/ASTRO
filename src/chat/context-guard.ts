/**
 * Guarda de contexto do chat (T1): estimativa por mensagem, aviso em 80% e
 * descarte do turno mais antigo acima de 100%, preservando o system prompt.
 * A estimativa é heurística (4 chars ≈ 1 token) — a mesma dos compactadores.
 */
import type { ChatMessage } from "../provider/types";

export function estimateMessageTokens(message: ChatMessage): number {
  const calls = message.toolCalls === undefined ? "" : JSON.stringify(message.toolCalls);
  return Math.ceil((message.content.length + calls.length) / 4);
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export interface GuardedContext {
  messages: ChatMessage[];
  /** Tokens depois do descarte. */
  tokens: number;
  /** Tokens antes do descarte. */
  originalTokens: number;
  ratio: number;
  /** Aviso de 80% (antes do descarte). */
  warning: boolean;
  trimmed: boolean;
}

/** Descarta o turno mais antigo (user..antes do próximo user); null se não há turno inteiro. */
export function trimOldestTurn(messages: readonly ChatMessage[]): ChatMessage[] | null {
  const start = messages.findIndex((message, index) => index > 0 && message.role === "user");
  if (start < 0) return null;
  const next = messages.findIndex((message, index) => index > start && message.role === "user");
  if (next < 0) return null;
  return [...messages.slice(0, start), ...messages.slice(next)];
}

/** Aplica o guard: mantém o system e turnos completos; nunca remove o turno atual. */
export function guardContext(messages: readonly ChatMessage[], contextTokens: number): GuardedContext {
  const originalTokens = estimateMessagesTokens(messages);
  let current = [...messages];
  let trimmed = false;
  while (estimateMessagesTokens(current) > contextTokens) {
    const next = trimOldestTurn(current);
    if (next === null) break;
    current = next;
    trimmed = true;
  }
  const tokens = estimateMessagesTokens(current);
  const ratio = contextTokens > 0 ? originalTokens / contextTokens : 0;
  return {
    messages: current,
    tokens,
    originalTokens,
    ratio,
    warning: ratio >= 0.8 || trimmed,
    trimmed,
  };
}
