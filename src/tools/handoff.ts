import { HandoffError, validateHandoffDraft, type HandoffDraft } from "../handoff/types";
import type { Tool, ToolContext, ToolManifest, ToolResult } from "./types";

/** Entrada da tool: destino + conteúdo do artefato declarado pelo emissor. */
export interface HandoffInput extends HandoffDraft {
  to: string;
}

export const handoffManifest: ToolManifest = {
  name: "handoff",
  description: "Transfere o controle para outro agent nomeado na configuração.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Nome do agent destino (deve existir em agents)" },
      task: { type: "string" }, objective: { type: "string" }, decisions: { type: "array", items: { type: "string" } }, constraints: { type: "array", items: { type: "string" } }, next_steps: { type: "array", items: { type: "string" } },
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

/** Tool de handoff — a execução real é feita pelo runtime multi-agent. */
export const handoffTool: Tool = {
  manifest: handoffManifest,
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (typeof raw.to !== "string" || raw.to.trim().length === 0) throw new HandoffError("handoff_artifact_mismatch", "campo 'to' (string) é obrigatório");
    const draft = validateHandoffDraft(raw);
    if (ctx.knownAgents !== undefined && !ctx.knownAgents.includes(raw.to)) throw new HandoffError("handoff_target_not_found", `agent destino "${raw.to}" não encontrado na configuração`);
    return { output: JSON.stringify({ handoff: true, to: raw.to, draft }), isError: false };
  },
};
