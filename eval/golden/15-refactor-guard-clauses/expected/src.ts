export function process(x: number | null): string {
  if (x === null) return "nulo";
  if (x <= 0) return "inválido";
  if (x >= 100) return "grande demais";
  return "válido";
}
