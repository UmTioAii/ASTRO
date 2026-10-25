import type { AstroConfig } from "./config";
import type { Auditor } from "./audit";
import { Registry, type ModelEntry } from "./registry";

/** Agent ativo no manager (F-28): nome, profile e modelo resolvido. */
export interface ManagedAgent {
  name: string;
  profile?: string;
  provider: string;
  model: string;
}

/**
 * Ciclo de vida de agentes nomeados (F-28): criar, listar, destruir — sobre
 * declarações da config (determinismo: a LLM nunca cria agente em runtime).
 * Cada transição gera evento de auditoria (I-04); orçamento continua com
 * `team.agentQuotas` (D-10, sem novo contador).
 */
export class AgentManager {
  readonly #registry: Registry;
  readonly #audit: Auditor;
  readonly #active = new Map<string, ManagedAgent>();

  constructor(opts: { registry: Registry; audit: Auditor }) {
    this.#registry = opts.registry;
    this.#audit = opts.audit;
  }

  /** Ativa um agent declarado na config; emite `agent.created` (I-04). */
  create(name: string, run: string): ManagedAgent {
    if (this.#active.has(name)) {
      throw new Error(`agent "${name}" já está ativo no manager`);
    }
    const agent = this.#registry.requireAgent(name);
    const resolved: ModelEntry =
      agent.profile === undefined
        ? this.#registry.require(agent.model)
        : this.#registry.resolveProfile(agent.profile);
    const managed: ManagedAgent = {
      name,
      provider: resolved.provider,
      model: resolved.id,
      ...(agent.profile === undefined ? {} : { profile: agent.profile }),
    };
    this.#active.set(name, managed);
    this.#audit.append({
      run,
      agent: name,
      tipo: "agent.created",
      payload: {
        name,
        provider: managed.provider,
        model: managed.model,
        ...(managed.profile === undefined ? {} : { profile: managed.profile }),
      },
    });
    return managed;
  }

  /** Lista os agents ativos. */
  list(): ManagedAgent[] {
    return [...this.#active.values()];
  }

  /** Desativa um agent ativo; emite `agent.destroyed` (I-04). */
  destroy(name: string, run: string): void {
    const managed = this.#active.get(name);
    if (managed === undefined) {
      throw new Error(`agent "${name}" não está ativo no manager`);
    }
    this.#active.delete(name);
    this.#audit.append({
      run,
      agent: name,
      tipo: "agent.destroyed",
      payload: {
        name,
        provider: managed.provider,
        model: managed.model,
        ...(managed.profile === undefined ? {} : { profile: managed.profile }),
      },
    });
  }
}

/** Linhas do `astro agents list` (F-28): leitura pura da config, sem eventos de audit. */
export function formatAgentsList(config: AstroConfig): string {
  if (config.agents === undefined || Object.keys(config.agents).length === 0) {
    return "nenhum agent nomeado declarado em agents";
  }
  const registry = new Registry(config);
  const lines: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    const resolved =
      agent.profile === undefined ? registry.require(agent.model) : registry.resolveProfile(agent.profile);
    lines.push(`${name} · ${agent.profile ?? "-"} · ${resolved.provider}/${resolved.id}`);
  }
  return lines.join("\n");
}
