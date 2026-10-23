/** Percentual de part sobre total (0-100); lança se total for zero. */
export function percent(part: number, total: number): number {
  if (total === 0) throw new Error("total zero");
  return (part / total) * 100;
}
