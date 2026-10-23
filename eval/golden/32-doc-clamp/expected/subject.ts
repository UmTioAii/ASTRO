/** Limita `n` ao intervalo [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
