import type { Auditor } from "../audit";
import { callId } from "../call-id";
import type { ToolCall, ToolDef } from "../provider/types";
import type { Tool, ToolContext, ToolResult } from "./types";

const TIMEOUT = Symbol("timeout");

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

/** Executa tools com allowlist, teto de escopo (ceiling), timeout e auditoria; erros voltam como resultado de tool. */
export class ToolExecutor {
  private readonly tools: readonly Tool[];
  private readonly byName: Map<string, Tool>;
  private readonly allowSet: Set<string>;
  private readonly ceilingSet: Set<string>;
  private readonly auditRef: Auditor;

  constructor(opts: { tools: readonly Tool[]; allow: string[]; audit: Auditor; ceiling?: string[] }) {
    this.tools = opts.tools;
    this.byName = new Map(opts.tools.map((tool) => [tool.manifest.name, tool]));
    this.allowSet = new Set(opts.allow);
    // Ceiling: teto de escopo para subagents (I-02). Default = allow (sem restrição extra).
    this.ceilingSet = new Set(opts.ceiling ?? opts.allow);
    this.auditRef = opts.audit;
  }

  /** Todas as tools registradas (para multi-agent session). */
  get allTools(): readonly Tool[] {
    return this.tools;
  }

  /** Allowlist do executor (para teto de subagents). */
  get allow(): ReadonlySet<string> {
    return this.allowSet;
  }

  /** Teto de escopo (ceiling) do executor (I-02). */
  get ceiling(): ReadonlySet<string> {
    return this.ceilingSet;
  }

  /** Auditoria da sessão (para tools de composição logarem eventos próprios). */
  get audit(): Auditor {
    return this.auditRef;
  }

  /** Definições das tools permitidas, no formato exposto ao provider. */
  defs(): ToolDef[] {
    return this.tools
      .filter((tool) => this.allowSet.has(tool.manifest.name))
      .map((tool) => ({
        name: tool.manifest.name,
        description: tool.manifest.description,
        parameters: tool.manifest.parameters,
      }));
  }

  async run(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    // Dedup por call_id determinístico (F-03), apenas para tools declaradas
    // idempotentes (F-10, I-12); as demais sempre executam de verdade.
    const { step, journal } = ctx;
    if (step !== undefined && journal !== undefined) {
      const id = callId(ctx.run, step, call);
      const tool = this.byName.get(call.name);
      const cached = tool?.manifest.idempotent === true ? journal.lookup(id) : undefined;
      if (cached !== undefined) {
        // Chamada suprimida NÃO emite tool.call/tool.result: as métricas de
        // duração continuam medindo só execuções reais.
        this.auditRef.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "tool.dedup",
          payload: { name: call.name, callId: id },
        });
        return cached;
      }
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.call",
        payload: { name: call.name, callId: id },
      });
      const result = await this.execute(ctx, call);
      journal.record(id, result);
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.result",
        payload: { name: call.name, isError: result.isError === true, callId: id },
      });
      return result;
    }

    this.auditRef.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.call",
      payload: { name: call.name },
    });

    const result = await this.execute(ctx, call);

    this.auditRef.append({
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
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason: "tool desconhecida" },
      });
      return failure(`tool desconhecida: "${call.name}"`);
    }
    if (!this.allowSet.has(call.name)) {
      const reason = `tool "${call.name}" não permitida para o agent "${ctx.agent}"`;
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason },
      });
      return failure(reason);
    }
    // Ceiling enforcement (I-02): tool no allow mas fora do teto do parent → negado
    if (!this.ceilingSet.has(call.name)) {
      const reason = `tool "${call.name}" fora do teto de escopo do agent "${ctx.agent}"`;
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason },
      });
      return failure(reason);
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
      const outcome = await Promise.race([tool.execute(input, { ...ctx, executor: this }), timeout]);

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
