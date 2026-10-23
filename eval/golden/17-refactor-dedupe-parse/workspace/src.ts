export function parsePair(a: string, b: string): [number, number] {
  const x = Number.parseInt(a, 10);
  const y = Number.parseInt(b, 10);
  if (Number.isNaN(x)) throw new Error("a inválido");
  if (Number.isNaN(y)) throw new Error("b inválido");
  return [x, y];
}
