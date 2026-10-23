export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
