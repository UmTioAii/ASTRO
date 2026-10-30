/**
 * Limite de saída por tool (S-16, CMP-10, ADR-0015): cap em tokens, artefato
 * com head+tail e referência de origem, e sanitização antes do contexto.
 *
 * O cap efetivo é `min(maxTokens, shareOfWindow × janela do modelo)`. O que
 * excede vai para um arquivo em `.astro/outputs`; o contexto recebe cabeçalho
 * com origem/tamanho, a cabeça e a cauda. Sem artefato gravável, o cabeçalho
 * marca `truncated_unrecoverable` (CMP-10).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "./sanitize-external";
import { estimateTokens } from "./tokens";

/** Config `outputLimit` (D-CFG1): teto absoluto e fração da janela. */
export interface OutputLimitConfig {
  maxTokens: number;
  shareOfWindow: number;
}

export const DEFAULT_OUTPUT_LIMIT: OutputLimitConfig = { maxTokens: 8000, shareOfWindow: 0.05 };

/** Cap efetivo em tokens: min(maxTokens, floor(shareOfWindow × janela)). */
export function effectiveOutputCap(config: OutputLimitConfig | undefined, contextWindow: number | undefined): number {
  const limit = config ?? DEFAULT_OUTPUT_LIMIT;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return limit.maxTokens;
  const share = Math.floor(contextWindow * limit.shareOfWindow);
  return Math.max(1, Math.min(limit.maxTokens, share));
}

export interface OutputLimitOptions {
  /** Teto em tokens estimados. */
  capTokens: number;
  /** Id da chamada da tool, usado no cabeçalho e no artefato. */
  toolCallId: string;
  /** Diretório do artefato (ex.: `<cwd>/.astro/outputs/<run>`). */
  artifactDir: string;
  /** Caminho exibido no contexto; default o próprio `artifactPath`. */
  displayPath?: (artifactPath: string) => string;
  /** Grava o artefato; default grava em disco. Injetável nos testes. */
  writeArtifact?: (path: string, content: string) => void;
}

export interface LimitedOutput {
  output: string;
  truncated: boolean;
  artifactPath?: string;
  unrecoverable?: boolean;
}

/** Id seguro para cabeçalho/nome de arquivo (call ids vêm do modelo). */
function safeLabel(value: string): string {
  // Sem `:` e sem nomes de device do Windows: o label vira nome de arquivo.
  const clean = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return clean.length === 0 ? "call" : clean;
}

function defaultWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * Sanitiza e, se passar do cap, grava o excedente e devolve
 * cabeçalho + cabeça + marcador + cauda. Determinístico para a mesma entrada.
 */
export function limitToolOutput(output: string, opts: OutputLimitOptions): LimitedOutput {
  const sanitized = redactSecrets(output);
  const tokens = estimateTokens(sanitized);
  if (tokens <= opts.capTokens) return { output: sanitized, truncated: false };

  const label = safeLabel(opts.toolCallId);
  const hash = createHash("sha256").update(sanitized).digest("hex").slice(0, 8);
  const artifactPath = join(opts.artifactDir, `${label}-${hash}.txt`);
  const write = opts.writeArtifact ?? defaultWrite;
  let written = false;
  try {
    write(artifactPath, sanitized);
    written = true;
  } catch {
    written = false;
  }

  // Cabeçalho, marcador e origem são aditivos ao orçamento; desconta-se uma
  // reserva fixa e nunca se pede mais do que o conteúdo tem (evita repetir
  // head/tail inteiros em caps minúsculos).
  const budget = Math.max(200, opts.capTokens * 4 - 512);
  const chars = Math.min(sanitized.length - 1, budget);
  const headChars = Math.floor(chars / 2);
  const tailChars = chars - headChars;
  const head = sanitized.slice(0, headChars);
  const tail = sanitized.slice(sanitized.length - tailChars);
  const middle = sanitized.slice(headChars, sanitized.length - tailChars);
  const omittedLines = (middle.match(/\n/g) ?? []).length;
  const omittedBytes = Buffer.byteLength(middle, "utf8");
  const totalLines = (sanitized.match(/\n/g) ?? []).length + (sanitized.endsWith("\n") ? 0 : 1);
  const totalBytes = Buffer.byteLength(sanitized, "utf8");

  const display = written ? (opts.displayPath?.(artifactPath) ?? artifactPath) : undefined;
  const lines = [
    `[saída truncada: ${tokens} tokens > limite ${opts.capTokens}; ${totalBytes} bytes; ${totalLines} linhas]`,
    `[origem: tool_call=${label}${display === undefined ? "; truncated_unrecoverable" : `; arquivo=${display}`}]`,
    head,
    `[... ${omittedLines} linhas omitidas (${omittedBytes} bytes) ...]`,
    tail,
  ];

  return {
    output: lines.join("\n"),
    truncated: true,
    ...(written ? { artifactPath } : {}),
    ...(written ? {} : { unrecoverable: true }),
  };
}
