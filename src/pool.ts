import type { AstroConfig } from "./config";
import { Registry } from "./registry";

/** Linhas do `astro pool list` (F-27). Pricing NÃO aparece: preço vive em `models[]` (ADR-0007). */
export function formatPoolList(config: AstroConfig): string {
  if (config.modelPool === undefined) {
    return "nenhum profile declarado em modelPool";
  }
  const registry = new Registry(config);
  const lines: string[] = [];
  for (const [name, profile] of Object.entries(config.modelPool)) {
    const model = registry.resolveProfile(name);
    const parts = [`${name} · ${model.provider}/${model.id}`, `tags ${model.tags.join(", ") || "-"}`,
      ...(profile.capabilities === undefined ? [] : [`exige ${profile.capabilities.join(", ")}`]),
      ...(profile.fallback === undefined || profile.fallback.length === 0 ? [] : [`fallback ${profile.fallback.join(", ")}`])];
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}
