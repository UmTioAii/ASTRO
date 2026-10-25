import { HandoffError, validateHandoffDraft, type HandoffDraft } from "../handoff/types";
import type { Tool, ToolContext, ToolManifest, ToolResult } from "./types";

/** Entrada da tool: destino + conteúdo do artefato declarado pelo emissor. */
export interface HandoffInput extends HandoffDraft {
  to: string;
}

export const handoffManifest: ToolManifest = {
  name: "handoff",
  description:
    "Transfere o controle para outro agent nomeado na configuração, com artefato durável (task, objective, decisions, constraints, next_steps).",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Nome do agent destino (deve existir em agents)" },
      task: { type: "string", description: "Tarefa em andamento no momento do handoff" },
      objective: { type: "string", description: "Objetivo a ser cumprido pelo receptor" },
      decisions: { type: "array", items: { type: "string" }, description: "Decisões já tomadas" },
      constraints: { type: "array", items: { type: "string" }, description: "Restrições a respeitar" },
      next_steps: { type: "array", items: { type: "string" }, description: "Próximos passos" },
    },
    required: ["to", "task", "objective", "decisions", "constraints", "next_steps"],
    additionalProperties: false,
  },
  risk: "medium",
  permission: "handoff",
  timeoutMs: 5000,
  retryable: false,
  idempotent: true,
  sideEffects: "none",
};

/** Tool de handoff — valida o artefato; a troca real é feita pelo runtime multi-agent. */
export const handoffTool: Tool = {
  manifest: handoffManifest,
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (typeof raw.to !== "string" || raw.to.trim().length === 0) {
      throw new HandoffError("handoff_artifact_mismatch", "campo 'to' (string) é obrigatório");
    }
    const draft = validateHandoffDraft(raw);
    if (ctx.knownAgents !== undefined && !ctx.knownAgents.includes(raw.to)) {
      throw new HandoffError(
        "handoff_target_not_found",
        `agent destino "${raw.to}" não encontrado na configuração`,
      );
    }
    // O runtime intercepta este resultado e faz a troca de agent
    return {
      output: JSON.stringify({ handoff: true, to: raw.to, draft }),
      isError: false,
    };
  },
};
