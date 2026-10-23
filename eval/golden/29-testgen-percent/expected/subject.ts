export function percent(part: number, total: number): number {
  if (total === 0) throw new Error("total zero");
  return (part / total) * 100;
}
