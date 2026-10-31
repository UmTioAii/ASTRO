import type { Auditor } from "../audit";
import { callId } from "../call-id";
import { limitToolOutput } from "../output-limit";
import {
  actionClassOf,
  permissionDecision,
  DEFAULT_PERMISSION_MODE,
  PermissionPendingError,
  type ActionClass,
  type PermissionDecision,
  type PermissionMode,
} from "../permissions";
import { join, relative } from "node:path";
import type { ToolCall, ToolDef } from "../provider/types";
import type { Tool, ToolContext, ToolResult } from "./types";

const TIMEOUT = Symbol("timeout");

/** Nome de diretório seguro para o run id (nunca escapa do cwd). */
function safeRunDir(run: string): string {
  const clean = run.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 64);
  return clean.length === 0 ? "run" : clean;
}

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
  /** Modo do gate por chamada (PERM-01); default `ask`. */
  private readonly mode: PermissionMode;
  /** Aprovação humana injetada pela TUI/REPL; ausente = sem prompt (PERM-04/07). */
  private readonly approveTool?: (request: { name: string; action: ActionClass; mode: PermissionMode }) => boolean;

  constructor(opts: {
    tools: readonly Tool[];
    allow: string[];
    audit: Auditor;
    ceiling?: string[];
    permissionMode?: PermissionMode;
    approveTool?: (request: { name: string; action: ActionClass; mode: PermissionMode }) => boolean;
  }) {
    this.tools = opts.tools;
    this.byName = new Map(opts.tools.map((tool) => [tool.manifest.name, tool]));
    this.allowSet = new Set(opts.allow);
    // Ceiling: teto de escopo para subagents (I-02). Default = allow (sem restrição extra).
    this.ceilingSet = new Set(opts.ceiling ?? opts.allow);
    this.auditRef = opts.audit;
    this.mode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.approveTool = opts.approveTool;
  }

  /** Modo de permissão corrente (subagente herda do executor pai). */
  get permissionMode(): PermissionMode {
    return this.mode;
  }

  /** Aprovador de tool por chamada (subagente herda do executor pai). */
  get toolApprover(): ((request: { name: string; action: ActionClass; mode: PermissionMode }) => boolean) | undefined {
    return this.approveTool;
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

    const blocked = this.permissionGate(ctx, tool, call, input);
    if (blocked !== undefined) return blocked;

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
      return this.limitOutput(ctx, call, outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro na tool "${call.name}": ${message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Gate por chamada depois do allowlist e do ceiling (PERM-01, I-01). `deny`
   * bloqueia; `ask` consulta o aprovador injetado pela TUI/REPL. Sem aprovador
   * a chamada segue (o CLI não interativo injeta um aprovador que nega em
   * `pending`, #262). O piso fixo (`.astro/`/`protectedPaths`, redação,
   * confinamento) é aplicado pelas próprias tools e não depende do modo.
   */
  private permissionGate(
    ctx: ToolContext,
    tool: Tool,
    call: ToolCall,
    input: unknown,
  ): ToolResult | undefined {
    const action = actionClassOf(tool, { name: call.name, input });
    const decision = permissionDecision(this.mode, action);
    let effective: PermissionDecision = decision;
    if (decision === "ask" && this.approveTool !== undefined) {
      try {
        effective = this.approveTool({ name: call.name, action, mode: this.mode }) ? "allow" : "deny";
      } catch (error) {
        // Sem TTY o aprovador não pode perguntar: pending, auditado e run para (I-08/I-19).
        if (error instanceof PermissionPendingError) {
          this.auditRef.append({
            run: ctx.run,
            agent: ctx.agent,
            tipo: "permission.pending",
            payload: { name: call.name, action, mode: this.mode },
          });
        }
        throw error;
      }
    }
    // `allow` automático só é auditado em bypass (#268): nele toda decisão fica rastreável.
    if (decision !== "allow" || this.mode === "bypass") {
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "permission.decision",
        payload: { name: call.name, action, mode: this.mode, decision: effective },
      });
    }
    if (effective !== "deny") return undefined;

    const reason = `permissão negada para a tool "${call.name}" (modo ${this.mode}, ação ${action})`;
    this.auditRef.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.denied",
      payload: { name: call.name, reason },
    });
    return failure(reason);
  }

  /** Cap de saída por tool (CMP-10): head+tail+origem, artefato em `.astro/outputs`. */
  private limitOutput(ctx: ToolContext, call: ToolCall, result: ToolResult): ToolResult {
    const capTokens = ctx.outputLimitTokens;
    if (capTokens === undefined || result.output.length === 0) return result;
    // O artefato de handoff é parseado pela sessão antes de virar mensagem e já
    // é compactado (compactDraft); truncar aqui perderia o handoff em silêncio.
    if (call.name === "handoff") return result;
    const limited = limitToolOutput(result.output, {
      capTokens,
      toolCallId: call.id,
      artifactDir: join(ctx.cwd, ".astro", "outputs", safeRunDir(ctx.run)),
      displayPath: (path) => relative(ctx.cwd, path),
    });
    // A sanitização para o contexto acontece na sessão; aqui o truncamento
    // precisa preservar a saída bruta para handoff/paths/ids.
    return limited.truncated ? { ...result, output: limited.output } : result;
  }
}
