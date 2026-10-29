/** Predicados de header/credencial compartilhados por config, store e plugins (I-03). */

const AUTH_HEADER = /(^|-)authorization$|(^|-)api[-_]?key$|(^|-)key$|(^|-)secret$|^cookie$|^set-cookie$|^x-auth(-|$)|token$/;
/** Headers que terminam em `-key` mas são metadado, não credencial. */
const METADATA_KEY_HEADERS = new Set(["idempotency-key"]);
const SECRET_VALUE = /^(sk-|nvapi-|AIza|ghp_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|eyJ[\w-]+\.[\w-]+\.)/;

export function isAuthHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (METADATA_KEY_HEADERS.has(lower)) return false;
  return AUTH_HEADER.test(lower);
}

export function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  // `Bearer ...`/`Basic ...` são credencial por construção, mesmo sem prefixo conhecido.
  if (/^(bearer|basic)\s+\S/i.test(trimmed)) return true;
  const text = trimmed.replace(/^(bearer|basic)\s+/i, "");
  return SECRET_VALUE.test(text);
}
