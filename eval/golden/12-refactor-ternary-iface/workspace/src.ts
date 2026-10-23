export function classify(n: number): string {
  return n < 0 ? "negativo" : n === 0 ? "zero" : n < 10 ? "pequeno" : "grande";
}
