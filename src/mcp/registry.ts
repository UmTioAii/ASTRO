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
 * Registro de servidores MCP (#56): descoberta com cache por servidor,
 * namespace `mcp__<server>__<tool>` e isolamento — a falha de um servidor não
 * derruba os demais nem a sessão; chamada a servidor caído reconecta uma vez.
 */
export class MCPRegistry {
  readonly #servers: Record<string, MCPServerConfig>;
  readonly #warn: (message: string) => void;
  readonly #states = new Map<string, ServerState>();

  constructor(opts: MCPRegistryOptions) {
    this.#servers = opts.servers;
    this.#warn = opts.warn ?? ((message: string) => console.warn(`mcp: ${message}`));
    for (const [name, server] of Object.entries(opts.servers)) {
      if (server.enabled) this.#states.set(name, { client: undefined, tools: [], failed: undefined });
    }
  }

  /** Conecta os habilitados; falha individual vira warn e entra em `failed`. */
  async connectAll(): Promise<{ connected: { server: string; name: string }[]; failed: { server: string; error: string }[] }> {
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
        this.#markFailed(state, error);
        this.#warn(`servidor MCP "${name}" indisponível: ${state.failed}`);
        failed.push({ server: name, error: state.failed! });
      }
    }
    return { connected, failed };
  }

  #markFailed(state: ServerState, error: unknown): void {
    state.client = undefined;
    state.tools = [];
    state.failed = error instanceof Error ? error.message : String(error);
  }

  listTools(): MCPDiscoveredTool[] {
    const out: MCPDiscoveredTool[] = [];
    for (const [server, state] of this.#states) {
      for (const tool of state.tools) out.push({ server, tool });
    }
    return out;
  }

  async #reconnect(server: string, state: ServerState): Promise<void> {
    state.client = await MCPClient.connect(this.#servers[server]!);
    state.tools = await state.client.listTools();
    state.failed = undefined;
  }

  /** Chama uma tool do servidor; caído reconecta uma vez antes de declarar indisponível. */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const state = this.#states.get(server);
    if (state === undefined) throw new MCPError(`servidor MCP "${server}" não configurado ou desabilitado`);
    if (state.client === undefined) {
      try {
        await this.#reconnect(server, state);
      } catch (error) {
        this.#markFailed(state, error);
        throw new MCPError(`servidor MCP "${server}" indisponível: ${state.failed}`);
      }
    }
    try {
      return await state.client!.callTool(tool, args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      state.client = undefined;
      state.tools = [];
      try {
        await this.#reconnect(server, state);
        return await state.client!.callTool(tool, args);
      } catch (retry) {
        this.#markFailed(state, retry);
        throw new MCPError(`servidor MCP "${server}" indisponível: ${detail}`);
      }
    }
  }

  /** Descarta o cache de tools de um servidor (invalidação em reconexão). */
  invalidate(server: string): void {
    const state = this.#states.get(server);
    if (state !== undefined) state.tools = [];
  }

  close(): void {
    for (const state of this.#states.values()) {
      state.client?.close();
      state.client = undefined;
      state.tools = [];
    }
  }
}
