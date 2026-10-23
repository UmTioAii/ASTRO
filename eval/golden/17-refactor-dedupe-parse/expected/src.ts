function parsePart(name: string, value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`${name} inválido`);
  return n;
}

export function parsePair(a: string, b: string): [number, number] {
  return [parsePart("a", a), parsePart("b", b)];
}
