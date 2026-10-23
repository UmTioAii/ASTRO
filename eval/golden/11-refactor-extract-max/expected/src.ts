export function max(xs: number[]): number {
  let m = xs[0] ?? 0;
  for (const x of xs) {
    if (x > m) m = x;
  }
  return m;
}

export function analyze(xs: number[]): { count: number; max: number } {
  return { count: xs.length, max: max(xs) };
}
