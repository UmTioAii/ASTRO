import type { AstroConfig, ModelConfig, ModelStatus } from "./config";
import { ConfigError } from "./config";

/** Modelo da configuração com o status sempre resolvido. */
export type ModelEntry = ModelConfig & { status: ModelStatus };

/**
 * Índice dos modelos declarados na configuração, por chave `"<provider>/<id>"`.
 */
export class Registry {
  readonly #entries = new Map<string, ModelEntry>();

  constructor(config: AstroConfig) {
    for (const model of config.models) {
      const key = `${model.provider}/${model.id}`;
      this.#entries.set(key, { ...model, status: model.status ?? "active" });
    }
  }

  /** Devolve o modelo com a chave informada, qualquer que seja o status. */
  get(key: string): ModelEntry | undefined {
    return this.#entries.get(key);
  }

  /** Devolve o modelo apenas se estiver ativo; caso contrário lança ConfigError. */
  require(key: string): ModelEntry {
    const model = this.#entries.get(key);
    if (model === undefined) {
      throw new ConfigError(`modelo "${key}" não encontrado na configuração`);
    }
    if (model.status !== "active") {
      throw new ConfigError(
        `modelo "${key}" não está active (status: "${model.status}"); ` +
          `selecione um modelo active na configuração`,
      );
    }
    return model;
  }

  /** Lista os modelos ativos, opcionalmente filtrando por tags. */
  list(filter?: { tags?: string[] }): ModelEntry[] {
    const tags = filter?.tags;
    return [...this.#entries.values()].filter(
      (model) =>
        model.status === "active" && (tags === undefined || tags.every((tag) => model.tags.includes(tag))),
    );
  }
}
