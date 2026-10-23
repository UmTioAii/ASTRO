/** Conta palavras separadas por espaços em branco. */
export function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}
