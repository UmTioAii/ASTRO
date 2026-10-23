/** Converte um título em slug: minúsculas, sem espaços nas bordas, espaços viram hífen. */
export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}
