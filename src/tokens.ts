/** Stub RED: contagem de tokens por provider (D-21). */
import type { ChatMessage, CompletionRequest } from "./provider/types";

export type TokenSource = "measured" | "estimate";

export interface TokenCount {
  tokens: number;
  source: TokenSource;
  tokenizer?: string;
}

export type Tokenizer = (text: string) => number;

export interface TokenCountOptions {
  provider?: string;
  model?: string;
}

export function registerTokenizer(_provider: string, _tokenizer: Tokenizer, _name?: string): void {
  throw new Error("não implementado");
}

export function unregisterTokenizer(_provider: string): void {
  throw new Error("não implementado");
}

export function hasTokenizer(_provider: string): boolean {
  throw new Error("não implementado");
}

export function estimateTokens(_text: string): number {
  throw new Error("não implementado");
}

export function countMessageTokens(_messages: readonly ChatMessage[], _opts: TokenCountOptions = {}): TokenCount {
  throw new Error("não implementado");
}

export function countRequestTokens(_request: CompletionRequest, _opts: TokenCountOptions = {}): TokenCount {
  throw new Error("não implementado");
}
