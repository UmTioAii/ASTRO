import type { AstroConfig, ModelConfig, ModelStatus, NamedAgentConfig, ProfileConfig } from "./config";
import { ConfigError } from "./config";
import { missingCapabilities, type Capability } from "./capabilities";

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
  readonly #profiles = new Map<string, ProfileConfig>();

  constructor(config: AstroConfig) {
    for (const model of config.models) {
      const key = `${model.provider}/${model.id}`;
      // C6: a tabela global de preços sobrescreve model.price — uma só fonte para todos os consumidores (D-10)
      const price = config.pricing?.[key] ?? model.price;
      this.#models.set(key, { ...model, status: model.status ?? "active", ...(price === undefined ? {} : { price }) });
    }
    if (config.modelPool) {
      for (const [name, profile] of Object.entries(config.modelPool)) {
        this.#profiles.set(name, { ...profile });
      }
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

  /** Devolve o modelo apenas se estiver ativo E atender às capabilities exigidas; caso contrário lança ConfigError. */
  require(key: string, required?: readonly Capability[]): ModelEntry {
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
    if (required !== undefined && required.length > 0) {
      const missing = missingCapabilities(model, required);
      if (missing.length > 0) {
        throw new ConfigError(
          `modelo "${key}" não atende às capabilities exigidas: ${missing.join(", ")}; ` +
            `declare as capabilities do modelo ou escolha outro na configuração`,
        );
      }
    }
    return model;
  }

  /** Lista os modelos ativos, opcionalmente filtrando por tags e capabilities exigidas. */
  list(filter?: { tags?: string[]; capabilities?: Capability[] }): ModelEntry[] {
    const tags = filter?.tags;
    const capabilities = filter?.capabilities;
    return [...this.#models.values()].filter(
      (model) =>
        model.status === "active" &&
        (tags === undefined || tags.every((tag) => model.tags.includes(tag))) &&
        (capabilities === undefined ||
          missingCapabilities(model, capabilities).length === 0),
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

  listAgentNames(): string[] { return [...this.#agents.keys()]; }

  /** Devolve o ModelEntry ativo resolvido do profile (F-27, ADR-0007). */
  resolveProfile(name: string): ModelEntry {
    const profile = this.#profiles.get(name);
    if (profile === undefined) {
      throw new ConfigError(
        this.#profiles.size === 0
          ? `profile "${name}" não encontrado: a config não declara "modelPool"`
          : `profile "${name}" não encontrado na modelPool da configuração`,
      );
    }
    return this.require(profile.model);
  }

  /** Resolve o ModelEntry do agent: profile da pool (F-29, ADR-0007) ou model direto. */
  resolveModel(agent: { model: string; profile?: string }): ModelEntry {
    return agent.profile === undefined ? this.require(agent.model) : this.resolveProfile(agent.profile);
  }
}
