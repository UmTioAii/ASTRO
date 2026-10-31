import { ModelChoiceError, listModelCandidates, type CandidateDeps, type CandidateQuery } from "../model-choice";
import type { Tool, ToolManifest, ToolResult } from "./types";

export const listModelCandidatesManifest: ToolManifest = {
  name: "list_model_candidates",
  description: "Lista modelos ranqueados da pool para um papel (need) e capacidades exigidas (requires).",
  parameters: {
    type: "object",
    properties: {
      need: { type: "string", description: "Tag de papel (planning, analysis, writing-text, writing-code, review, testing)" },
      requires: {
        type: "array",
        items: { type: "string" },
        description: "Tags de capacidade exigidas (tools, reasoning, long-context, vision, fast)",
      },
      estimatedInputTokens: { type: "integer", minimum: 0, description: "Entrada estimada para o filtro de contexto" },
    },
    required: ["need"],
    additionalProperties: false,
  },
  risk: "low",
  permission: "list_model_candidates",
  class: "read_common",
  timeoutMs: 5000,
  retryable: false,
  idempotent: true,
  sideEffects: "none",
};

/** Tool de listagem; as deps são resolvidas no run (config/ledger/registry). */
export function createListModelCandidatesTool(deps: () => CandidateDeps): Tool {
  return {
    manifest: listModelCandidatesManifest,
    async execute(input: unknown): Promise<ToolResult> {
      const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

      if (typeof raw.need !== "string" || raw.need.trim().length === 0) {
        throw new ModelChoiceError("invalid_need", "campo 'need' (string) é obrigatório");
      }
      const requires = raw.requires;
      if (requires !== undefined && (!Array.isArray(requires) || requires.some((tag) => typeof tag !== "string"))) {
        throw new ModelChoiceError("invalid_requires", "campo 'requires' deve ser uma lista de tags");
      }
      const estimated = raw.estimatedInputTokens;
      if (
        estimated !== undefined &&
        (typeof estimated !== "number" || !Number.isInteger(estimated) || estimated < 0)
      ) {
        throw new ModelChoiceError("invalid_request", "campo 'estimatedInputTokens' deve ser inteiro >= 0");
      }

      const query: CandidateQuery = {
        need: raw.need,
        ...(requires === undefined ? {} : { requires: requires as string[] }),
        ...(estimated === undefined ? {} : { estimatedInputTokens: estimated }),
      };
      return { output: JSON.stringify(listModelCandidates(query, deps())), isError: false };
    },
  };
}
