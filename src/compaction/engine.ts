/**
 * Motor de compactação de sessão (S-17, CMP-1..CMP-5, CMP-8): gatilho por
 * janela, parte recente, níveis de redução e artefato. O resumo é gerado por
 * um callback injetado que NUNCA expõe tools (CMP-4).
 */
import type { ChatMessage } from "../provider/types";
import { countMessageTokens } from "../tokens";
import { buildCompactionArtifact, renderCompactionArtifact, type CompactionArtifactV1 } from "./types";

/** Config `compaction` (D-CFG1): `buffer: null` usa o default do ADR-0015. */
export interface CompactionConfig {
  buffer: number | null;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = { buffer: null };

/** Parte recente preservada, em tokens (CMP-2). */
export const RECENT_TOKENS = 15_000;

/** Instrução do resumo; a chamada não expõe tools (CMP-4). */
export const SUMMARY_PROMPT =
  "Resuma o histórico a seguir de forma concisa, preservando fatos, decisões, arquivos e tarefas pendentes. Não inclua saudações nem meta-comentários.";

/** Menor orçamento para o histórico antigo no pedido de resumo. */
const MIN_SUMMARY_BUDGET = 2_000;
const CLIP_TOOL_CHARS = 2_000;
const CLIP_INPUT_CHARS = 4_000;

/** Reserva da janela (CMP-1): max(15% da janela, 16.000) ou `buffer` explícito. */
export function reserveTokens(window: number, buffer?: number | null): number {
  if (buffer !== null && buffer !== undefined && buffer < window) return buffer;
  return Math.max(Math.ceil(window * 0.15), 16_000);
}

/**
 * A estimativa atingiu `window - reserve`? Janela que não comporta a reserva
 * (ex.: 8k com default de 16k) não compacta: não haveria espaço para o resumo.
 */
export function shouldCompact(
  messages: readonly ChatMessage[],
  window: number,
  buffer?: number | null,
  opts: { provider?: string } = {},
): boolean {
  const reserve = reserveTokens(window, buffer);
  if (window <= reserve) return false;
  const tokens = countMessageTokens(messages, opts).tokens;
  return tokens >= window - reserve;
}

/**
 * Índice onde começa a parte recente: acumula do fim até o orçamento e recua
 * até o início de uma mensagem de usuário (nunca no meio de tool call/result).
 */
export function recentSliceStart(messages: readonly ChatMessage[], budget: number = RECENT_TOKENS): number {
  if (messages.length <= 1) return messages.length;
  let sum = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 1; index--) {
    const tokens = countMessageTokens([messages[index]!]).tokens;
    if (sum + tokens > budget && start < messages.length) break;
    sum += tokens;
    start = index;
  }

  let probe = start;
  while (probe >= 1 && messages[probe]!.role !== "user") probe--;
  return probe >= 1 ? probe : start;
}

/** Nível de redução (1–5) e mensagens do histórico antigo para o resumo. */
export interface ReducedHistory {
  level: 1 | 2 | 3 | 4 | 5;
  messages: ChatMessage[];
}

function clipBoth(value: string): string {
  if (value.length <= CLIP_TOOL_CHARS * 2) return value;
  return `${value.slice(0, CLIP_TOOL_CHARS)}\n[... truncado ...]\n${value.slice(-CLIP_TOOL_CHARS)}`;
}

/** Aplica um nível de redução (CMP-5) ao histórico antigo. */
export function applyReduction(older: readonly ChatMessage[], level: 1 | 2 | 3 | 4 | 5): ReducedHistory {
  switch (level) {
    case 1:
      return { level, messages: [...older] };
    case 2:
      return {
        level,
        messages: older.map((message) => message.role === "tool"
          ? { ...message, content: clipBoth(message.content) }
          : message),
      };
    case 3:
      return {
        level,
        messages: older
          .filter((message) => message.role !== "tool")
          .map((message) => ({
            ...message,
            content: message.content.slice(0, CLIP_INPUT_CHARS),
            ...(message.toolCalls === undefined ? {} : { toolCalls: undefined }),
          }))
          .map(({ toolCalls: _dropped, ...message }) => message as ChatMessage),
      };
    case 4:
      return {
        level,
        messages: older
          .filter((message) => message.role === "user")
          .map((message) => ({ ...message, content: message.content.slice(0, CLIP_INPUT_CHARS) })),
      };
    case 5:
      return { level, messages: [] };
  }
}

export interface CompactInput {
  run: string;
  /** Histórico completo; a primeira mensagem é o system prompt. */
  messages: readonly ChatMessage[];
  window: number;
  buffer?: number | null;
  /** Modelo ativo para tokenizer nativo. */
  provider?: string;
  /** Orçamento da parte recente; default 15.000 tokens (CMP-2). */
  recentBudget?: number;
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
export async function compactSession(input: CompactInput): Promise<CompactResult> {
  const hasSystem = input.messages[0]?.role === "system";
  const recentStart = recentSliceStart(input.messages, input.recentBudget ?? RECENT_TOKENS);
  const older = input.messages.slice(hasSystem ? 1 : 0, recentStart);
  const recent = input.messages.slice(recentStart);
  const countOpts = input.provider === undefined ? {} : { provider: input.provider };

  const originalTokens = countMessageTokens(input.messages, countOpts).tokens;
  const recentTokens = countMessageTokens(recent, countOpts).tokens;
  const budget = Math.max(
    MIN_SUMMARY_BUDGET,
    input.window - reserveTokens(input.window, input.buffer) - recentTokens,
  );

  let reduction: ReducedHistory = { level: 5, messages: [] };
  for (const level of [1, 2, 3, 4] as const) {
    const candidate = applyReduction(older, level);
    if (countMessageTokens(candidate.messages, countOpts).tokens <= budget) {
      reduction = candidate;
      break;
    }
  }

  const summary = reduction.level === 5
    ? "histórico antigo omitido (redução 5)"
    : await input.summarize([
      { role: "system", content: SUMMARY_PROMPT },
      ...reduction.messages,
    ]);

  const artifact = buildCompactionArtifact({ run: input.run, older, recent, summary });
  const compacted: ChatMessage[] = [
    ...(hasSystem ? [input.messages[0]!] : []),
    { role: "system", content: renderCompactionArtifact(artifact) },
    ...recent,
  ];

  return {
    messages: compacted,
    artifact,
    reduction: reduction.level,
    originalTokens,
    returnedTokens: countMessageTokens(compacted, countOpts).tokens,
  };
}
