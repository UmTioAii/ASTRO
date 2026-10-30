/**
 * Contagem de tokens por provider (S-19, D-22, ADR-0015): pura, determinística,
 * sem chamadas a provider e sem segredo (I-03). Tokenizer nativo quando o
 * provider registra um; senão estimativa documentada de 4 chars/token, sempre
 * marcada como `estimate` e nunca zero para texto não vazio.
 */
import type { ChatMessage, CompletionRequest, ToolDef } from "./provider/types";

/** De onde veio a contagem: tokenizer do provider ou estimativa 4 chars/token. */
export type TokenSource = "measured" | "estimate";

/** Resultado puro da contagem. */
export interface TokenCount {
  tokens: number;
  source: TokenSource;
  /** Nome lógico do tokenizer, quando medido. */
  tokenizer?: string;
}

export type Tokenizer = (text: string) => number;

export interface TokenCountOptions {
  /** Provider ativo; seleciona o tokenizer nativo registrado. */
  provider?: string;
}

interface RegisteredTokenizer {
  fn: Tokenizer;
  name: string;
}

const TOKENIZERS = new Map<string, RegisteredTokenizer>();

/** Chave canônica do provider: registro e consulta usam a mesma normalização. */
function providerKey(provider: string): string {
  return provider.trim();
}

/** Registra o tokenizer nativo de um provider (idempotente). */
export function registerTokenizer(provider: string, tokenizer: Tokenizer, name = provider): void {
  const key = providerKey(provider);
  if (key.length === 0) throw new Error("provider vazio no registro de tokenizer");
  TOKENIZERS.set(key, { fn: tokenizer, name });
}

/** Remove o tokenizer de um provider (testes/plugins). */
export function unregisterTokenizer(provider: string): void {
  TOKENIZERS.delete(providerKey(provider));
}

/** Existe tokenizer nativo para o provider? */
export function hasTokenizer(provider: string): boolean {
  return TOKENIZERS.has(providerKey(provider));
}

/** Estimativa documentada: 4 caracteres por token, zero só para texto vazio. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function tokenizerFor(opts: TokenCountOptions): RegisteredTokenizer | undefined {
  if (opts.provider === undefined) return undefined;
  return TOKENIZERS.get(providerKey(opts.provider));
}

/** Soma as peças de texto; cada peça é medida ou estimada e nunca vira zero se não vazia. */
function countPieces(pieces: readonly string[], opts: TokenCountOptions): TokenCount {
  const tokenizer = tokenizerFor(opts);
  let tokens = 0;
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const value = tokenizer === undefined ? estimateTokens(piece) : tokenizer.fn(piece);
    // Texto não vazio nunca conta zero: um tokenizer que devolve 0 está quebrado
    // e não pode fazer a compactação acreditar que a mensagem é grátis.
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`tokenizer "${tokenizer?.name ?? "estimate"}" retornou contagem inválida para texto não vazio`);
    }
    tokens += Math.trunc(value);
  }
  if (tokens === 0) return { tokens: 0, source: "estimate" };
  return tokenizer === undefined
    ? { tokens, source: "estimate" }
    : { tokens, source: "measured", tokenizer: tokenizer.name };
}

function messagePieces(message: ChatMessage): string[] {
  const pieces = [message.content];
  if (message.toolCallId !== undefined) pieces.push(message.toolCallId);
  for (const call of message.toolCalls ?? []) {
    pieces.push(call.id, call.name, call.arguments);
  }
  return pieces;
}

function toolPieces(tool: ToolDef): string[] {
  return [tool.name, tool.description, JSON.stringify(tool.parameters)];
}

/** Conta uma lista de mensagens para o provider/model ativo. */
export function countMessageTokens(messages: readonly ChatMessage[], opts: TokenCountOptions = {}): TokenCount {
  return countPieces(messages.flatMap(messagePieces), opts);
}

/** Conta mensagens + definições de tools da request (o que vai ao provider). */
export function countRequestTokens(request: CompletionRequest, opts: TokenCountOptions = {}): TokenCount {
  return countPieces(
    [...request.messages.flatMap(messagePieces), ...(request.tools ?? []).flatMap(toolPieces)],
    opts,
  );
}
