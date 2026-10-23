export function includesAll<T>(xs: readonly T[], needles: readonly T[]): boolean {
  const set = new Set(xs);
  return needles.every((n) => set.has(n));
}
