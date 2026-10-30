/** Helpers puros do seletor de modelos (#227): filtro, ordem, favoritos e detalhe. */
export interface ModelOption {
  ref: string;
  provider: string;
  id: string;
  tags: string[];
  context: number;
  status: string;
  price?: { inputPerM: number; outputPerM: number; fonte: string; verificado: boolean };
}

const MAX_RECENT = 10;

export function filterModels(models: readonly ModelOption[], query: string): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...models];
  return models.filter((model) =>
    model.ref.toLowerCase().includes(needle) ||
    model.id.toLowerCase().includes(needle) ||
    model.provider.toLowerCase().includes(needle) ||
    model.tags.some((tag) => tag.toLowerCase().includes(needle)));
}

/** Favoritos, depois recentes, depois o resto; refs fora da lista atual somem. */
export function orderModels(
  models: readonly ModelOption[],
  favorites: readonly string[],
  recents: readonly string[],
): ModelOption[] {
  const byRef = new Map(models.map((model) => [model.ref, model]));
  const seen = new Set<string>();
  const ordered: ModelOption[] = [];
  for (const ref of [...favorites, ...recents, ...models.map((model) => model.ref)]) {
    if (seen.has(ref)) continue;
    const model = byRef.get(ref);
    if (model === undefined) continue;
    seen.add(ref);
    ordered.push(model);
  }
  return ordered;
}

export function recordRecent(ref: string, recents: readonly string[]): string[] {
  return [ref, ...recents.filter((item) => item !== ref)].slice(0, MAX_RECENT);
}

export function toggleFavorite(ref: string, favorites: readonly string[]): string[] {
  return favorites.includes(ref) ? favorites.filter((item) => item !== ref) : [...favorites, ref];
}

export function modelDetail(model: ModelOption): string {
  const price = model.price === undefined
    ? "preço: n/d"
    : `preço: in ${model.price.inputPerM}/M out ${model.price.outputPerM}/M (${model.price.fonte}${model.price.verificado ? "" : ", não verificado"})`;
  const tags = model.tags.length === 0 ? "tags: -" : `tags: ${model.tags.join(", ")}`;
  return `${model.ref} · ${model.status} · contexto ${model.context} · ${tags} · ${price}`;
}
