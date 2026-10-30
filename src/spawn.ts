/**
 * Spawn de subagente em runtime (C4a, ADR-0008): registra o filho, adquire a
 * conta exclusiva (A4) e devolve a identidade para o handoff do orchestrator.
 * Execução é serial no v1: o filho só roda quando recebe o handoff.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Auditor } from "./audit";
import { AccountLockedError, acquireAgentLock } from "./agent-lock";
import type { AstroConfig, BudgetConfig } from "./config";
import { providerAccountRefFor } from "./config";
import type { Ledger } from "./ledger";
import {
  listModelCandidates,
  ModelChoiceError,
  resolveModelChoice,
  type CandidateDeps,
  type ModelCandidate,
} from "./model-choice";
import type { QuotaLimit } from "./quota";
import type { AgentEntry, Registry } from "./registry";
import type { Tool, ToolContext, ToolResult } from "./tools/types";

/** Teto de spawns por run (A2). */
export const DEFAULT_MAX_SPAWNS_PER_RUN = 8;
const MAX_AGENTS_MD = 16_000;

/** Limite de spawns do run excedido (golden §11.3). */
export class SpawnLimitError extends Error {
  readonly code = "spawn_limit_exceeded";
  constructor(limit: number) {
    super(`limite de ${limit} spawns por run excedido`);
    this.name = "SpawnLimitError";
  }
}

/** Subagente nascido em runtime, fixado no spawn (ADR-0007/0008). */
export interface SpawnedAgent {
  agent_id: string;
  parent_agent_id: string;
  candidate: ModelCandidate;
  tools: string[];
  maxSteps: number;
  /** AGENTS.md + task entregues ao filho (A9). */
  instructions: string;
  reason: string;
  createdAt: number;
}

/** Estado de spawns do run (v1 serial). */
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

  /** Próximo id livre, sem colidir com agents declarados. */
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

  /** Converte o spawn para o contrato de agent do loop multi-agent. */
  toAgentEntry(agent: SpawnedAgent, baseSystemPrompt?: string): AgentEntry {
    const systemPrompt = [baseSystemPrompt, agent.instructions].filter((part) => part !== undefined && part.length > 0).join("\n\n");
    return {
      model: agent.candidate.model,
      ...(agent.candidate.profile === undefined ? {} : { profile: agent.candidate.profile }),
      maxSteps: agent.maxSteps,
      tools: agent.tools,
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
    };
  }
}

/** Dependências do tool (o run injeta config/ledger/registry/spawns). */
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

function candidateDeps(deps: SpawnToolDeps): CandidateDeps {
  return {
    config: deps.config,
    registry: deps.registry,
    ledger: deps.ledger,
    ...(deps.quotaLimits === undefined ? {} : { quotaLimits: deps.quotaLimits }),
    ...(deps.budget === undefined ? {} : { budget: deps.budget }),
  };
}

function readAgentsMd(cwd: string): string {
  try {
    const text = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    return text.length > MAX_AGENTS_MD ? text.slice(0, MAX_AGENTS_MD) : text;
  } catch {
    return "";
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function toolError(error: unknown): ToolResult {
  if (error instanceof ModelChoiceError || error instanceof AccountLockedError || error instanceof SpawnLimitError) {
    const candidates = error instanceof ModelChoiceError ? error.candidates : undefined;
    return {
      output: JSON.stringify({
        error: error.code,
        message: error.message,
        ...(candidates === undefined ? {} : { candidates }),
      }),
      isError: true,
    };
  }
  throw error;
}

const SPAWN_PARAMETERS = {
  type: "object",
  properties: {
    need: { type: "string", description: "Papel do subagente (ROLE_TAGS)" },
    task: { type: "string", description: "Tarefa entregue ao subagente" },
    model: { type: "string", description: "Modelo do snapshot (provider/id); omitido = rank 1" },
    reason: { type: "string", maxLength: 200, description: "Justificativa da escolha" },
    tools: { type: "array", items: { type: "string" }, description: "Subconjunto das tools do pai" },
    maxTurns: { type: "integer", minimum: 1, description: "Teto de passos do subagente (≤ pai)" },
    snapshot_id: { type: "string", description: "Snapshot de list_model_candidates" },
  },
  required: ["need", "task"],
  additionalProperties: false,
};

/** Tool `spawn_agent` (A1/A2/A3/A5/A10/A11). */
export function createSpawnAgentTool(deps: SpawnToolDeps): Tool {
  return {
    manifest: {
      name: "spawn_agent",
      description: "Cria um subagente com modelo da pool, escopo ⊆ pai e conta exclusiva; use handoff para executá-lo.",
      parameters: SPAWN_PARAMETERS,
      risk: "medium",
      permission: "spawn_agent",
      timeoutMs: 5000,
      retryable: false,
      idempotent: false,
      sideEffects: "none",
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      try {
        const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        if (typeof raw.need !== "string" || raw.need.trim().length === 0) {
          return { output: JSON.stringify({ error: "invalid_need", message: "campo 'need' é obrigatório" }), isError: true };
        }
        if (typeof raw.task !== "string" || raw.task.trim().length === 0) {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'task' é obrigatório" }), isError: true };
        }
        if (raw.model !== undefined && typeof raw.model !== "string") {
          return { output: JSON.stringify({ error: "invalid_model_choice", message: "campo 'model' deve ser string" }), isError: true };
        }
        if (raw.reason !== undefined && typeof raw.reason !== "string") {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'reason' deve ser string" }), isError: true };
        }
        if (raw.snapshot_id !== undefined && typeof raw.snapshot_id !== "string") {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'snapshot_id' deve ser string" }), isError: true };
        }
        if (raw.tools !== undefined && !isStringArray(raw.tools)) {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'tools' deve ser lista de strings" }), isError: true };
        }
        const maxTurns = raw.maxTurns;
        if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'maxTurns' deve ser inteiro >= 1" }), isError: true };
        }

        if (deps.spawns.size >= deps.spawns.limit) throw new SpawnLimitError(deps.spawns.limit);

        const parentAllow = ctx.allow ?? [];
        const tools = raw.tools === undefined ? [...parentAllow] : raw.tools;
        const outside = tools.filter((tool) => !parentAllow.includes(tool));
        if (outside.length > 0) {
          return {
            output: JSON.stringify({
              error: "invalid_request",
              message: `tools fora do escopo do pai: ${outside.join(", ")}`,
            }),
            isError: true,
          };
        }

        const parentMax = ctx.maxSteps ?? deps.config.agent.maxSteps;
        const childMax = maxTurns ?? parentMax;
        if (childMax > parentMax) {
          return {
            output: JSON.stringify({
              error: "invalid_request",
              message: `maxTurns ${childMax} excede o teto do pai (${parentMax})`,
            }),
            isError: true,
          };
        }

        const cdeps = candidateDeps(deps);
        let choice;
        if (raw.snapshot_id !== undefined) {
          choice = resolveModelChoice(raw.snapshot_id, raw.model, cdeps);
        } else {
          const query = {
            need: raw.need,
            ...(tools.length > 0 ? { requires: ["tools"] } : {}),
          };
          const snapshot = listModelCandidates(query, cdeps);
          choice = resolveModelChoice(snapshot.snapshot_id, raw.model, cdeps);
        }

        const slash = choice.candidate.model.indexOf("/");
        const provider = choice.candidate.model.slice(0, slash);
        const modelId = choice.candidate.model.slice(slash + 1);
        const providerConfig = deps.config.providers[provider];
        if (providerConfig === undefined) {
          return { output: JSON.stringify({ error: "invalid_model_choice", message: `provider "${provider}" desconhecido` }), isError: true };
        }

        const accountRef = providerAccountRefFor(provider, providerConfig);
        const rawCredential = (providerConfig as { credentialRef?: unknown }).credentialRef;
        const keyless = providerConfig.kind === "openai-compat" &&
          (typeof rawCredential !== "string" || rawCredential.length === 0);
        const agentId = deps.spawns.nextId(new Set(Object.keys(deps.config.agents ?? {})));
        const reason = (typeof raw.reason === "string" && raw.reason.length > 0 ? raw.reason : choice.reason).slice(0, 200);
        const instructions = [raw.task, readAgentsMd(deps.cwd)]
          .filter((part) => part.length > 0)
          .join("\n\n");

        acquireAgentLock(deps.ledger, deps.audit, {
          run: ctx.run,
          agent_id: agentId,
          session_id: ctx.run,
          provider,
          model: modelId,
          ...(keyless ? {} : { credentialRef: accountRef }),
          accountRef,
          ...(choice.candidate.profile === undefined ? {} : { profile: choice.candidate.profile }),
          parent_agent_id: ctx.agent,
          reason,
        });

        deps.spawns.add({
          agent_id: agentId,
          parent_agent_id: ctx.agent,
          candidate: choice.candidate,
          tools: [...tools],
          maxSteps: childMax,
          instructions,
          reason,
          createdAt: Date.now(),
        });
        deps.audit.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "agent.spawned",
          payload: {
            agent_id: agentId,
            parent_agent_id: ctx.agent,
            model: choice.candidate.model,
            ...(choice.candidate.profile === undefined ? {} : { profile: choice.candidate.profile }),
            reason,
          },
        });

        return {
          output: JSON.stringify({
            agent_id: agentId,
            model: choice.candidate.model,
            ...(choice.candidate.profile === undefined ? {} : { profile: choice.candidate.profile }),
            status: "active",
          }),
          isError: false,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  };
}
