export function last<T>(xs: T[]): T | null {
  return xs.length === 0 ? null : xs[xs.length - 1]!;
}
