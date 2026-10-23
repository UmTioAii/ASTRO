const RULES: Array<{ limit: number; label: string }> = [
  { limit: 0, label: "negativo" },
  { limit: 1, label: "zero" },
  { limit: 10, label: "pequeno" },
];

export function classify(n: number): string {
  for (const rule of RULES) {
    if (n < rule.limit) return rule.label;
  }
  return "grande";
}
