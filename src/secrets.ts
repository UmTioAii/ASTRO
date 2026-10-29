/** Predicados de header/credencial compartilhados por config, store e plugins (I-03). */

const AUTH_HEADER = /(^|-)authorization$|(^|-)api[-_]?key$|(^|-)key$|(^|-)secret$|^cookie$|^set-cookie$|^x-auth(-|$)|token$/;
const SECRET_VALUE = /^(sk-|nvapi-|AIza|ghp_|github_pat_|glpat-|xox[baprs]-)/;

export function isAuthHeader(name: string): boolean {
  return AUTH_HEADER.test(name.toLowerCase());
}

export function looksLikeSecret(value: string): boolean {
  const text = value.trim().replace(/^bearer\s+/i, "");
  return SECRET_VALUE.test(text);
}
