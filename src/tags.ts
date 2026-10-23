/**
 * Vocabulário fechado de tags (D-17).
 *
 * Papel/uso descreve para que o modelo é bom; capacidade descreve o que ele
 * suporta. Qualquer tag fora destas listas torna a configuração inválida.
 */

export const ROLE_TAGS: readonly string[] = [
  "planning",
  "analysis",
  "writing-text",
  "writing-code",
  "review",
  "testing",
];

export const CAPACITY_TAGS: readonly string[] = [
  "tools",
  "reasoning",
  "long-context",
  "vision",
  "fast",
];

const KNOWN_TAGS = new Set<string>([...ROLE_TAGS, ...CAPACITY_TAGS]);

export function isKnownTag(tag: string): boolean {
  return KNOWN_TAGS.has(tag);
}
