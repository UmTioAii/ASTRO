/** Devolve o primeiro caractere, ou null para string vazia. */
export function firstChar(s: string): string | null {
  return s.length === 0 ? null : s[0]!;
}
