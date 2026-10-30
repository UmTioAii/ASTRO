/** Stub do spawn (RED): registry real e tool sem implementação. */
import type { Auditor } from "./audit";
import type { AstroConfig, BudgetConfig } from "./config";
import type { Ledger } from "./ledger";
import type { ModelCandidate } from "./model-choice";
import type { QuotaLimit } from "./quota";
import type { AgentEntry, Registry } from "./registry";
import type { Tool, ToolResult } from "./tools/types";

export const DEFAULT_MAX_SPAWNS_PER_RUN = 8;

export class SpawnLimitError extends Error {
  readonly code = "spawn_limit_exceeded";
  constructor(limit: number) {
    super(`limite de ${limit} spawns por run excedido`);
    this.name = "SpawnLimitError";
  }
}

export interface SpawnedAgent {
  agent_id: string;
  parent_agent_id: string;
  candidate: ModelCandidate;
  tools: string[];
  maxSteps: number;
  instructions: string;
  reason: string;
  createdAt: number;
}

export class SpawnRegistry {
  readonly #agents = new Map<string, SpawnedAgent>();
  readonly #limit: number;
  #count = 0;

  constructor(opts: { limit?: number } = {}) {
    this.#limit = opts.limit ?? DEFAULT_MAX_SPAWNS_PER_RUN;
  }

  get size(): number {
    return this.#agents.size;
  }

  get limit(): number {
    return this.#limit;
  }

  get(agentId: string): SpawnedAgent | undefined {
    return this.#agents.get(agentId);
  }

  list(): SpawnedAgent[] {
    return [...this.#agents.values()];
  }

  nextId(reserved: ReadonlySet<string>): string {
    for (;;) {
      this.#count++;
      const id = `sub-${this.#count}`;
      if (!reserved.has(id) && !this.#agents.has(id)) return id;
    }
  }

  add(agent: SpawnedAgent): void {
    this.#agents.set(agent.agent_id, agent);
  }

  toAgentEntry(agent: SpawnedAgent, baseSystemPrompt?: string): AgentEntry {
    const systemPrompt = [baseSystemPrompt, agent.instructions]
      .filter((part) => part !== undefined && part.length > 0)
      .join("\n\n");
    return {
      model: agent.candidate.model,
      ...(agent.candidate.profile === undefined ? {} : { profile: agent.candidate.profile }),
      maxSteps: agent.maxSteps,
      tools: agent.tools,
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
    };
  }
}

export interface SpawnToolDeps {
  config: AstroConfig;
  registry: Registry;
  ledger: Ledger;
  audit: Auditor;
  cwd: string;
  spawns: SpawnRegistry;
  quotaLimits?: Record<string, QuotaLimit>;
  budget?: BudgetConfig;
}

export function createSpawnAgentTool(_deps: SpawnToolDeps): Tool {
  return {
    manifest: {
      name: "spawn_agent",
      description: "Stub",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      risk: "medium",
      permission: "spawn_agent",
      timeoutMs: 5000,
      retryable: false,
      idempotent: false,
      sideEffects: "none",
    },
    async execute(): Promise<ToolResult> {
      throw new Error("não implementado");
    },
  };
}
