/** Devolve cópia invertida; não muta a lista original. */
export function reverseCopy<T>(xs: T[]): T[] {
  return [...xs].reverse();
}
