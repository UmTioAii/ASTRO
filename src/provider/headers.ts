/** Predicados de header/credencial compartilhados por config e store (I-03). */

const AUTH_HEADER = /(^|-)authorization$|(^|-)api[-_]?key$|(^|-)key$|(^|-)secret$|^cookie$|^set-cookie$|^x-auth-|token$/;
const SECRET_VALUE = /^(sk-|nvapi-|AIza|ghp_|github_pat_|glpat-|xox[baprs]-)/;

export function isAuthHeader(name: string): boolean {
  return AUTH_HEADER.test(name.toLowerCase());
}

export function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE.test(value.trim());
}
