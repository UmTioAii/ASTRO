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
}

interface ServerState {
  client: MCPClient | undefined;
  tools: MCPToolDescriptor[];
  failed: string | undefined;
}

/**
 * Registro de servidores MCP (#56): descoberta com cache, namespace e
 * isolamento; `call` só reconecta em morte de transporte (`client.closed`).
 */
export class MCPRegistry {
  readonly #servers: Record<string, MCPServerConfig>;
  readonly #warn: (message: string) => void;
  readonly #states = new Map<string, ServerState>();
  readonly #reconnecting = new Map<string, Promise<void>>();
  #closed = false;

  constructor(opts: MCPRegistryOptions) {
    this.#servers = opts.servers;
    this.#warn = opts.warn ?? ((message: string) => console.warn(`mcp: ${message}`));
    for (const [name, server] of Object.entries(opts.servers)) {
      if (server.enabled) this.#states.set(name, { client: undefined, tools: [], failed: undefined });
    }
  }

  /** Conecta os habilitados; falha individual vira warn e entra em `failed`. */
  async connectAll(): Promise<{ connected: { server: string; name: string }[]; failed: { server: string; error: string }[] }> {
    if (this.#closed) throw new MCPError("registro MCP fechado");
    const connected: { server: string; name: string }[] = [];
    const failed: { server: string; error: string }[] = [];
    for (const name of this.#states.keys()) {
      const state = this.#states.get(name)!;
      try {
        state.client = await MCPClient.connect(this.#servers[name]!);
        state.tools = await state.client.listTools();
        state.failed = undefined;
        connected.push({ server: name, name: state.client.serverInfo.name });
      } catch (error) {
        this.#fail(name, state, error);
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

  listTools(): MCPDiscoveredTool[] {
    const out: MCPDiscoveredTool[] = [];
    for (const [server, state] of this.#states) for (const tool of state.tools) out.push({ server, tool });
    return out;
  }

  /** Reconexão única por servidor: chamadas concorrentes compartilham a mesma tentativa. */
  #reconnect(server: string, state: ServerState): Promise<void> {
    const inFlight = this.#reconnecting.get(server);
    if (inFlight !== undefined) return inFlight;
    const attempt = (async () => {
      state.client?.close();
      const client = await MCPClient.connect(this.#servers[server]!);
      state.client = client;
      state.tools = await client.listTools();
      state.failed = undefined;
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
      try { await this.#reconnect(server, state); } catch (error) { this.#fail(server, state, error); throw new MCPError(`servidor MCP "${server}" indisponível: ${state.failed}`); }
    }
    try {
      return await state.client!.callTool(tool, args);
    } catch (error) {
      if (!state.client!.closed) throw error; // transporte vivo: erro da tool, sem reconexão
      const detail = error instanceof Error ? error.message : String(error);
      this.#fail(server, state, error);
      try {
        await this.#reconnect(server, state);
        return await state.client!.callTool(tool, args);
      } catch (retry) {
        this.#fail(server, state, retry);
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
