import type { AstroConfig, ModelConfig, ModelStatus, NamedAgentConfig } from "./config";
import { ConfigError } from "./config";

/** Modelo da configuração com o status sempre resolvido. */
export type ModelEntry = ModelConfig & { status: ModelStatus };

/** Agent nomeado da configuração. */
export type AgentEntry = NamedAgentConfig;

/**
 * Índice dos modelos e agents declarados na configuração.
 */
export class Registry {
  readonly #models = new Map<string, ModelEntry>();
  readonly #agents = new Map<string, AgentEntry>();

  constructor(config: AstroConfig) {
    for (const model of config.models) {
      const key = `${model.provider}/${model.id}`;
      this.#models.set(key, { ...model, status: model.status ?? "active" });
    }
    if (config.agents) {
      for (const [name, agent] of Object.entries(config.agents)) {
        this.#agents.set(name, { ...agent });
      }
    }
  }

  /** Devolve o modelo com a chave informada, qualquer que seja o status. */
  get(key: string): ModelEntry | undefined {
    return this.#models.get(key);
  }

  /** Devolve o modelo apenas se estiver ativo; caso contrário lança ConfigError. */
  require(key: string): ModelEntry {
    const model = this.#models.get(key);
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
    return [...this.#models.values()].filter(
      (model) =>
        model.status === "active" && (tags === undefined || tags.every((tag) => model.tags.includes(tag))),
    );
  }

  /** Devolve o agent nomeado, se existir. */
  getAgent(name: string): AgentEntry | undefined {
    return this.#agents.get(name);
  }

  /** Devolve o agent nomeado; lança ConfigError se não existir. */
  requireAgent(name: string): AgentEntry {
    const agent = this.#agents.get(name);
    if (agent === undefined) {
      throw new ConfigError(`agent "${name}" não encontrado na configuração`);
    }
    return agent;
  }

  /** Lista todos os agents nomeados. */
  listAgents(): AgentEntry[] {
    return [...this.#agents.values()];
  }
}
