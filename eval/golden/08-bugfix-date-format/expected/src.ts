function pad(n: number): string {
  return String(n).padStart(2, "0");
}
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
