export function process(x: number | null): string {
  if (x !== null) {
    if (x > 0) {
      if (x < 100) {
        return "válido";
      }
      return "grande demais";
    }
    return "inválido";
  }
  return "nulo";
}
