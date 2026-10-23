export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}
