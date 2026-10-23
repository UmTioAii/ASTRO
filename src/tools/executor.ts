import type { Auditor } from "../audit";
import type { ToolCall, ToolDef } from "../provider/types";
import type { Tool, ToolContext, ToolResult } from "./types";

const TIMEOUT = Symbol("timeout");

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

/** Executa tools com allowlist, timeout e auditoria; erros voltam como resultado de tool. */
export class ToolExecutor {
  private readonly tools: Tool[];
  private readonly byName: Map<string, Tool>;
  private readonly allow: Set<string>;
  private readonly audit: Auditor;

  constructor(opts: { tools: Tool[]; allow: string[]; audit: Auditor }) {
    this.tools = opts.tools;
    this.byName = new Map(opts.tools.map((tool) => [tool.manifest.name, tool]));
    this.allow = new Set(opts.allow);
    this.audit = opts.audit;
  }

  /** Definições das tools permitidas, no formato exposto ao provider. */
  defs(): ToolDef[] {
    return this.tools
      .filter((tool) => this.allow.has(tool.manifest.name))
      .map((tool) => ({
        name: tool.manifest.name,
        description: tool.manifest.description,
        parameters: tool.manifest.parameters,
      }));
  }

  async run(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    this.audit.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.call",
      payload: { name: call.name },
    });

    const result = await this.execute(ctx, call);

    this.audit.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.result",
      payload: { name: call.name, isError: result.isError === true },
    });

    return result;
  }

  private async execute(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    const tool = this.byName.get(call.name);
    if (tool === undefined) {
      return failure(`tool desconhecida: "${call.name}"`);
    }
    if (!this.allow.has(call.name)) {
      return failure(`tool "${call.name}" não permitida para este agente`);
    }

    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      return failure(`argumentos ilegíveis para a tool "${call.name}": JSON inválido`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), tool.manifest.timeoutMs);
      });
      const outcome = await Promise.race([tool.execute(input, ctx), timeout]);

      if (outcome === TIMEOUT) {
        return failure(
          `timeout: a tool "${call.name}" excedeu ${tool.manifest.timeoutMs}ms`,
        );
      }
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro na tool "${call.name}": ${message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
