import type { Tool, ToolContext, ToolManifest, ToolResult } from "./types";
import { ToolError } from "./types";

export interface HandoffInput {
  to: string;
  payload?: Record<string, unknown>;
}

export const handoffManifest: ToolManifest = {
  name: "handoff",
  description: "Transfere o controle para outro agent nomeado na configuração.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Nome do agent destino (deve existir em agents)" },
      payload: { type: "object", description: "Dados opcionais para passar ao próximo agent" },
    },
    required: ["to"],
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
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = input as HandoffInput;
    if (!parsed.to || typeof parsed.to !== "string") {
      throw new ToolError("handoff: campo 'to' (string) é obrigatório");
    }
    // O runtime intercepta este resultado e faz a troca de agent
    return {
      output: JSON.stringify({ handoff: true, to: parsed.to, payload: parsed.payload ?? {} }),
      isError: false,
    };
  },
};