export function keysSorted(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}
