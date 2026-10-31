/**
 * Plugin system (F7-1): carrega tools e provider factories de plugins via
 * dynamic import, sem tocar no core. Plugin é um módulo (arquivo .ts ou
 * pacote npm) que exporta `definePlugin()`. Falha de load é isolada: warn no
 * console e o ASTRO segue sem o plugin.
 */
import { isAbsolute, resolve } from "node:path";
import type { Provider } from "./provider/types";
import type { Tool } from "./tools/types";

/** Fábrica de provider registrada por plugin, keyed por `kind` da config. */
export interface PluginProviderFactory {
  kind: string;
  create(rawConfig: Record<string, unknown>, env: Record<string, string | undefined>): Provider;
}

/** Contrato do que um plugin pode registrar. */
export interface PluginDefinition {
  name: string;
  tools?: Tool[];
  providers?: PluginProviderFactory[];
}

/** Identidade para DX: plugins exportam `definePlugin({...})`. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

/** Resultado do carregamento: tools e factories registradas. */
export interface LoadedPlugins {
  tools: Tool[];
  providerFactories: Map<string, PluginProviderFactory>;
}

/** Entrada local (path) é confiável; pacote remoto exige allowlist explícita (I-13). */
function isLocalEntry(entry: string): boolean {
  return entry.startsWith(".") || isAbsolute(entry);
}

/** Allowlist de plugins remotos; vem do env, nunca da config (que pode ser puxada de registry). */
export function pluginAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.ASTRO_PLUGIN_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/** Resolve a entrada da config: caminho absoluto/relativo vira import direto. */
async function importPlugin(entry: string): Promise<unknown> {
  const isPath = isLocalEntry(entry);
  if (isPath) {
    const absolute = resolve(entry);
    return import(absolute);
  }
  return import(entry);
}

/** Extrai a definição do módulo importado (export default ou nomeado). */
function extractDefinition(mod: unknown): PluginDefinition | null {
  const record = mod as Record<string, unknown>;
  const candidates = [record.plugin, record.default, record.definePlugin];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      const result = (candidate as () => unknown)();
      if (isPluginDefinition(result)) return result;
    }
    if (isPluginDefinition(candidate)) return candidate;
  }
  return null;
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string";
}

/** Carrega os plugins declarados; falhas isoladas (warn e segue). */
export async function loadPlugins(
  entries: readonly string[],
  opts: { warn?: (msg: string) => void; allowlist?: ReadonlySet<string> } = {},
): Promise<LoadedPlugins> {
  const warn = opts.warn ?? ((msg) => console.warn(msg));
  const allowlist = opts.allowlist ?? new Set<string>();
  const tools: Tool[] = [];
  const providerFactories = new Map<string, PluginProviderFactory>();

  for (const entry of entries) {
    if (!isLocalEntry(entry) && !allowlist.has(entry)) {
      // fail closed: pacote remoto só carrega com aprovação local explícita
      warn(`plugin remoto "${entry}" não está em ASTRO_PLUGIN_ALLOWLIST; ignorado`);
      continue;
    }
    try {
      const mod = await importPlugin(entry);
      const definition = extractDefinition(mod);
      if (definition === null) {
        warn(`plugin "${entry}" não exporta definePlugin/plugin válido; ignorado`);
        continue;
      }
      for (const tool of definition.tools ?? []) {
        if (typeof tool.manifest?.name !== "string") {
          warn(`plugin "${definition.name}" registrou tool sem manifesto; ignorada`);
          continue;
        }
        tools.push(tool);
      }
      for (const factory of definition.providers ?? []) {
        if (typeof factory.kind !== "string" || typeof factory.create !== "function") {
          warn(`plugin "${definition.name}" registrou provider factory inválido; ignorado`);
          continue;
        }
        providerFactories.set(factory.kind, factory);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warn(`falha ao carregar o plugin "${entry}": ${detail}; seguindo sem ele`);
    }
  }

  return { tools, providerFactories };
}