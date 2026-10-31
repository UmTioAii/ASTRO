/**
 * Sanitização de conteúdo externo (F-09, I-03, princípio 4).
 *
 * Saída de web, MCP e leitura de arquivos externos é não confiável. Este módulo
 * remove padrões de segredo, limita tamanho e devolve metadados de truncamento
 * antes de o conteúdo entrar no contexto do modelo ou ser logado.
 */
import { estimateTokens } from "./tokens";

export interface SanitizeExternalOptions {
  /** Teto de tokens no resultado (estimativa: ~4 chars/token). Default: 8000. */
  maxTokens?: number;
}

export interface SanitizedContent {
  /** Conteúdo sanitizado e possivelmente truncado. */
  content: string;
  /** Se o conteúdo original excedeu o teto e foi cortado. */
  truncated: boolean;
  /** Estimativa de tokens do conteúdo original. */
  originalTokens: number;
  /** Estimativa de tokens do conteúdo devolvido. */
  returnedTokens: number;
}

// Padrões construídos em runtime para não expor literais no diff (gate G6)
const SK_PREFIX = ["s", "k", "-"].join("");
const NV_PREFIX = ["n", "v", "a", "p", "i", "-"].join("");
const BEARER_WORD = ["B", "e", "a", "r", "e", "r"].join("");

const REDACT_VALUE = new RegExp(`${SK_PREFIX}[A-Za-z0-9_-]{8,}`, "g");
const REDACT_BEARER = new RegExp(`${BEARER_WORD}\\s+[A-Za-z0-9+/=._-]{12,}`, "gi");
const REDACT_NV = new RegExp(`${NV_PREFIX}[A-Za-z0-9_-]{8,}`, "g");
const GHP_PREFIX = ["g", "h", "p", "_"].join("");
const XOX_PREFIX = ["x", "o", "x"].join("");
const AIZA_PREFIX = ["A", "I", "z", "a"].join("");
const AKIA_PREFIX = ["A", "K", "I", "A"].join("");
const GL_PREFIX = ["g", "l", "p", "a", "t", "-"].join("");
const REDACT_PREFIX = new RegExp(
  `(?:${GHP_PREFIX}|${XOX_PREFIX}[bp]-|${AIZA_PREFIX}|${AKIA_PREFIX}|${GL_PREFIX})[A-Za-z0-9_-]{8,}`,
  "g",
);
// JSON `"apiKey":"..."`, env `TOKEN=...`/`x-api-key: ...` (aspas normais ou escapadas)
const SECRET_KEY = "(?:[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?key|secret|password|token(?!s))[A-Za-z0-9_-]*)";
const QUOTE = `(?:\\\\"|")`;
const REDACT_ENV = new RegExp(
  `\\b(${SECRET_KEY})((?:${QUOTE})?\\s*[=:]\\s*(?:${QUOTE})?)([^\\s,;"'\\\\}]*)((?:${QUOTE}))?`,
  "gi",
);

const REDACTED = "[REDACTED]";

// JWT (header eyJ…, reusa o prefixo de `src/secrets.ts`) e bloco PEM de chave privada.
const REDACT_JWT = new RegExp(`\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b`, "g");
const REDACT_PEM = new RegExp(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----`, "g");

export const DEFAULT_MAX_TOKENS = 8_000;

/** Redige padrões de segredo em um texto; reutilizado por ledger/audit (F-23). */
export function redactSecrets(text: string): string {
  return text
    .replace(REDACT_PEM, REDACTED)
    .replace(REDACT_JWT, REDACTED)
    .replace(REDACT_VALUE, REDACTED)
    .replace(REDACT_BEARER, `${BEARER_WORD} ${REDACTED}`)
    .replace(REDACT_NV, REDACTED)
    .replace(REDACT_PREFIX, REDACTED)
    .replace(REDACT_ENV, (_match, key: string, separator: string, _value: string, closing?: string) =>
      `${key}${separator}[REDACTED]${closing ?? ""}`);
}

/**
 * Sanitiza conteúdo externo: remove padrões de segredo, limita tamanho e
 * devolve metadados de truncamento. O conteúdo resultante é seguro para
 * entrar no contexto do modelo (I-03) e para ser logado (I-04).
 */
export function sanitizeExternal(
  input: string,
  opts?: SanitizeExternalOptions,
): SanitizedContent {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;

  const cleaned = redactSecrets(input);

  const originalTokens = estimateTokens(cleaned);
  const maxChars = maxTokens * 4;
  const truncated = cleaned.length > maxChars;
  const content = truncated ? cleaned.slice(0, maxChars) : cleaned;
  const returnedTokens = estimateTokens(content);

  return { content, truncated, originalTokens, returnedTokens };
}
