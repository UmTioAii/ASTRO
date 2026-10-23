/** Remove duplicados preservando a primeira ocorrência e a ordem. */
export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
