export function evens(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of xs) {
    if (x % 2 === 0) out.push(x);
  }
  return out;
}
