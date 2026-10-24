/**
 * Matriz de capability por modelo (F-07, I-21): vocabulário fechado de chaves
 * booleanas declaradas em `models[*].capabilities`, consultada antes da escolha.
 *
 * - Declarativo, sem default mágico: capability não declarada (ou `false`)
 *   conta como ausente.
 * - `context` existente em `models[]` permanece a janela de contexto e não é
 *   duplicado aqui (sem duplicação).
 * - Chave desconhecida = config inválida, no padrão de vocabulário fechado
 *   de tags (D-05/D-17).
 */

/** Vocabulário fechado de capabilities conhecidas. */
export const CAPABILITY_KEYS = ["tools", "streaming", "jsonMode"] as const;

/** Capability do vocabulário fechado. */
export type Capability = (typeof CAPABILITY_KEYS)[number];

/** Verifica se a chave pertence ao vocabulário fechado. */
export function isKnownCapability(key: string): boolean {
  return (CAPABILITY_KEYS as readonly string[]).includes(key);
}

/** Modelo com capabilities declaráveis (estrutural — aceita ModelConfig). */
interface WithCapabilities {
  capabilities?: Partial<Record<Capability, boolean>>;
}

/**
 * Devolve as capabilities exigidas e ausentes no modelo, na ordem exigida.
 * Função pura: consultável antes de qualquer escolha de modelo (I-06).
 */
export function missingCapabilities(
  model: WithCapabilities,
  required: readonly Capability[],
): Capability[] {
  return required.filter((cap) => model.capabilities?.[cap] !== true);
}
