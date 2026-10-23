export function flatten(xs: unknown[]): unknown[] {
  return xs.flat(Infinity) as unknown[];
}
