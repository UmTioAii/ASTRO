export function lengths(words: string[]): number[] {
  const out: number[] = [];
  for (const w of words) {
    out.push(w.length);
  }
  return out;
}
