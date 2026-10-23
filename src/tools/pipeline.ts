import type { Tool, ToolContext, ToolResult } from "./types";
import { ToolError } from "./types";

/**
 * Tool `pipeline` — composição de tools em sequência, numa única call.
 *
 * Cada step executa uma tool já registrada no executor da sessão, respeitando a
 * MESMA allowlist do agent (I-01): sub-tool fora da allowlist é negada. O output
 * de um step vira o campo `stdin` do input do step seguinte. Falha em qualquer
 * step interrompe o pipeline com erro acumulado.
 */

const MAX_STEPS = 10;

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface PipelineStep {
  tool: string;
  input: Record<string, unknown>;
}

interface PipelineInput {
  steps: PipelineStep[];
}

function parseInput(input: unknown): PipelineInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { steps }");
  }
  const raw = input as { steps?: unknown };
  if (!Array.isArray(raw.steps)) {
    throw new ToolError('"steps" deve ser uma lista de { tool, input }');
  }
  if (raw.steps.length === 0) {
    throw new ToolError('"steps" não pode ser vazio');
  }
  if (raw.steps.length > MAX_STEPS) {
    throw new ToolError(`"steps" aceita no máximo ${MAX_STEPS} steps (recebido: ${raw.steps.length})`);
  }

  const steps: PipelineStep[] = raw.steps.map((step, index) => {
    if (typeof step !== "object" || step === null) {
      throw new ToolError(`steps[${index}] deve ser um objeto { tool, input }`);
    }
    const s = step as { tool?: unknown; input?: unknown };
    if (typeof s.tool !== "string" || s.tool.length === 0) {
      throw new ToolError(`steps[${index}].tool deve ser uma string não vazia`);
    }
    if (s.tool === "pipeline") {
      throw new ToolError("pipeline não pode ser sub-tool de pipeline (sem recursão)");
    }
    if (typeof s.input !== "object" || s.input === null || Array.isArray(s.input)) {
      throw new ToolError(`steps[${index}].input deve ser um objeto`);
    }
    return { tool: s.tool, input: s.input as Record<string, unknown> };
  });

  return { steps };
}

/** Composição de tools em sequência; sub-tools passam pela allowlist do agent. */
export const pipelineTool: Tool = {
  manifest: {
    name: "pipeline",
    description:
      "Executa uma sequência de tools numa única call. O output de cada step vira o campo " +
      "'stdin' do input do step seguinte. Falha em qualquer step interrompe o pipeline. " +
      "Sub-tools precisam estar na allowlist do agent; pipeline não pode ser aninhado.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Steps sequenciais: [{ tool, input }]. Máximo de 10.",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Nome da tool a executar." },
              input: { type: "object", description: "Input da tool; recebe 'stdin' do step anterior." },
            },
            required: ["tool", "input"],
          },
        },
      },
      required: ["steps"],
    },
    risk: "high",
    permission: "write",
    timeoutMs: 120_000,
    retryable: false,
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { steps } = parseInput(input);

      const executor = ctx.executor;
      if (executor === undefined) {
        return failure("pipeline requer executor no contexto (sessão deve executar via ToolExecutor)");
      }

      const outputs: { step: number; tool: string; isError: boolean }[] = [];
      let previousOutput: string | undefined;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;

        const stepInput: Record<string, unknown> = { ...step.input };
        if (previousOutput !== undefined) {
          stepInput.stdin = previousOutput;
        }

        let result: ToolResult;
        try {
          result = await executor.run(ctx, {
            id: `pipeline-${i}`,
            name: step.tool,
            arguments: JSON.stringify(stepInput),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = { output: message, isError: true };
        }

        const isError = result.isError === true;
        outputs.push({ step: i, tool: step.tool, isError });

        // Auditoria: um evento pipeline.step por step (D-09)
        executor.audit.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "pipeline.step",
          payload: { step: i, tool: step.tool, isError },
        });

        if (isError) {
          return {
            output: JSON.stringify({
              pipeline: "failed",
              failedStep: i,
              tool: step.tool,
              error: result.output,
              steps: outputs,
            }),
            isError: true,
          };
        }

        previousOutput = result.output;
      }

      // Output final: resultado do último step
      return { output: previousOutput ?? "" };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no pipeline: ${message}`);
    }
  },
};