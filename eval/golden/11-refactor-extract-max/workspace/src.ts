export function analyze(xs: number[]): { count: number; max: number } {
  let max = xs[0] ?? 0;
  for (const x of xs) {
    if (x > max) max = x;
  }
  return { count: xs.length, max };
}
