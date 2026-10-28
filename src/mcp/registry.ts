import type { MCPServerConfig } from "../config";
import { MCPClient } from "./client";
import { MCPError, type MCPToolDescriptor, type MCPToolResult } from "./types";

/** Nome da tool MCP vista pelo modelo: `mcp__<server>__<tool>` (#56). */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export interface MCPDiscoveredTool {
  server: string;
  tool: MCPToolDescriptor;
}

export interface MCPRegistryOptions {
  servers: Record<string, MCPServerConfig>;
  warn?: (message: string) => void;
  /** Relógio injetável (teste determinístico do backoff); default `Date.now`. */
  now?: () => number;
}

/** Base do backoff quando o servidor não declara `retryBackoffMs`. */
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
/** Teto do backoff exponencial entre reconexões. */
const MAX_RETRY_BACKOFF_MS = 30_000;

interface ServerState {
  client: MCPClient | undefined;
  tools: MCPToolDescriptor[];
  failed: string | undefined;
  /** Falhas consecutivas de CONEXÃO (expoente do backoff). */
  failures: number;
  /** Instante (epoch ms) a partir do qual nova reconexão é permitida. */
  nextRetryAt: number;
}

/**
 * Registro de servidores MCP (#56): descoberta com cache, namespace e
 * isolamento; `call` só reconecta em morte de transporte (`client.closed`).
 */
export class MCPRegistry {
  readonly #servers: Record<string, MCPServerConfig>;
  readonly #warn: (message: string) => void;
  readonly #now: () => number;
  readonly #states = new Map<string, ServerState>();
  readonly #reconnecting = new Map<string, Promise<void>>();
  #closed = false;

  constructor(opts: MCPRegistryOptions) {
    this.#servers = opts.servers;
    this.#warn = opts.warn ?? ((message: string) => console.warn(`mcp: ${message}`));
    this.#now = opts.now ?? Date.now;
    for (const [name, server] of Object.entries(opts.servers)) {
      if (server.enabled) this.#states.set(name, { client: undefined, tools: [], failed: undefined, failures: 0, nextRetryAt: 0 });
    }
  }

  /** Conecta os habilitados; falha individual vira warn e entra em `failed`. */
  async connectAll(): Promise<{ connected: { server: string; name: string }[]; failed: { server: string; error: string }[] }> {
    if (this.#closed) throw new MCPError("registro MCP fechado");
    const connected: { server: string; name: string }[] = [];
    const failed: { server: string; error: string }[] = [];
    for (const name of this.#states.keys()) {
      if (this.#closed) throw new MCPError("registro MCP fechado"); // close() no meio do loop não spawna mais nada
      const state = this.#states.get(name)!;
      try {
        await this.#reconnect(name, state);
        connected.push({ server: name, name: state.client!.serverInfo.name });
      } catch (error) {
        if (this.#closed) throw new MCPError("registro MCP fechado");
        this.#fail(name, state, error);
        this.#cooldown(name, state);
        failed.push({ server: name, error: state.failed! });
      }
    }
    return { connected, failed };
  }

  /** Fecha o cliente antes de descartá-lo (sem processo órfão) e avisa a queda. */
  #fail(name: string, state: ServerState, error: unknown): void {
    state.client?.close();
    state.client = undefined;
    state.tools = [];
    state.failed = error instanceof Error ? error.message : String(error);
    this.#warn(`servidor MCP "${name}" indisponível: ${state.failed}`);
  }

  /** Backoff só para falha de CONEXÃO: o próximo `call` espera o intervalo exponencial. */
  #cooldown(name: string, state: ServerState): void {
    state.failures += 1;
    const base = this.#servers[name]?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    state.nextRetryAt = this.#now() + Math.min(base * 2 ** (state.failures - 1), MAX_RETRY_BACKOFF_MS);
  }

  listTools(): MCPDiscoveredTool[] {
    const out: MCPDiscoveredTool[] = [];
    for (const [server, state] of this.#states) for (const tool of state.tools) out.push({ server, tool });
    return out;
  }

  /** Reconexão única por servidor: concorrentes compartilham a tentativa; respeta close(). */
  #reconnect(server: string, state: ServerState): Promise<void> {
    const inFlight = this.#reconnecting.get(server);
    if (inFlight !== undefined) return inFlight;
    const attempt = (async () => {
      if (state.client !== undefined && !state.client.closed) return; // outra chamada já reconectou
      state.client?.close();
      const client = await MCPClient.connect(this.#servers[server]!);
      if (this.#closed) { client.close(); throw new MCPError("registro MCP fechado"); }
      state.client = client;
      state.tools = await client.listTools();
      state.failed = undefined;
      state.failures = 0;
      state.nextRetryAt = 0;
    })();
    this.#reconnecting.set(server, attempt);
    return attempt.finally(() => this.#reconnecting.delete(server));
  }

  /** Só reconecta quando o transporte morreu; erro de tool (protocolo) propaga sem reexecução. */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (this.#closed) throw new MCPError("registro MCP fechado");
    const state = this.#states.get(server);
    if (state === undefined) throw new MCPError(`servidor MCP "${server}" não configurado ou desabilitado`);
    if (state.client === undefined) {
      // Backoff: falha recente de conexão bloqueia nova tentativa até o instante calculado (sem spawnar).
      const waitMs = state.nextRetryAt - this.#now();
      if (waitMs > 0) {
        throw new MCPError(`servidor MCP "${server}" indisponível: ${state.failed ?? "falha anterior"} (nova tentativa em ${waitMs}ms)`);
      }
      try { await this.#reconnect(server, state); }
      catch (error) {
        if (this.#closed) throw new MCPError("registro MCP fechado");
        this.#fail(server, state, error);
        this.#cooldown(server, state);
        throw new MCPError(`servidor MCP "${server}" indisponível: ${state.failed}`);
      }
    }
    // Referência desta chamada: irmãos concorrentes podem trocar/anular state.client no meio.
    const client = state.client!;
    try {
      return await client.callTool(tool, args);
    } catch (error) {
      if (!client.closed) throw error; // transporte vivo: erro da tool, sem reconexão/reexecução
      const detail = error instanceof Error ? error.message : String(error);
      if (state.client === client) this.#fail(server, state, error); // só a primeira a falhar avisa
      try {
        await this.#reconnect(server, state);
        if (this.#closed) throw new MCPError("registro MCP fechado");
        return await state.client!.callTool(tool, args);
      } catch (retry) {
        if (this.#closed) throw new MCPError("registro MCP fechado");
        if (state.client !== undefined && state.client.closed) this.#fail(server, state, retry);
        else if (state.client === undefined) this.#cooldown(server, state); // reconexão falhou: backoff
        throw new MCPError(`servidor MCP "${server}" indisponível: ${detail}`);
      }
    }
  }

  /** Fecha todos os clientes; o registro não aceita mais chamadas. */
  close(): void {
    this.#closed = true;
    for (const state of this.#states.values()) { state.client?.close(); state.client = undefined; state.tools = []; }
  }
}
