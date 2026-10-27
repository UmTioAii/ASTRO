import { spawn } from "node:child_process";
import { sanitizedEnv } from "../../tools/run-command";
import { MCPError } from "../types";

/**
 * Transport stdio do MCP (#56): JSON-RPC 2.0 delimitado por newline no
 * stdin/stdout de um processo. O servidor é código arbitrário — o ambiente é
 * o mesmo sanitizado do run_command (I-03): nada de chaves do host, só o `env`
 * explícito da config.
 */
export interface StdioTransportOptions { command: string; args: string[]; env?: Record<string, string>; timeoutMs: number }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class StdioTransport {
  #proc: ReturnType<typeof spawn> | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #closed = false;
  #buffer = "";

  private constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  static connect(opts: StdioTransportOptions): StdioTransport {
    const transport = new StdioTransport(opts.timeoutMs);
    transport.#proc = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...sanitizedEnv(process.env), ...(opts.env ?? {}) },
      windowsHide: true,
    });
    transport.#proc.stdout!.setEncoding("utf8");
    transport.#proc.stdout!.on("data", (chunk: string) => transport.#onData(chunk));
    transport.#proc.on("error", (error) => transport.#failAll(error));
    transport.#proc.on("exit", () => transport.#failAll(new MCPError("processo do servidor MCP encerrou")));
    return transport;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue; // linha inválida não derruba o transport
      }
      if (typeof message.id !== "number") continue; // notificação do servidor: ignorada por ora
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new MCPError(message.error.message ?? "erro do servidor MCP"));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed || this.#proc === undefined) {
      return Promise.reject(new MCPError("transport MCP fechado"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MCPError(`timeout de ${this.#timeoutMs}ms no MCP ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#proc!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new MCPError(`falha ao escrever no MCP: ${String(error)}`));
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.#closed && this.#proc !== undefined) this.#proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** True depois que o processo encerrou ou o transport foi fechado. */
  get closed(): boolean {
    return this.#closed;
  }

  close(): void { this.#failAll(new MCPError("transport MCP fechado")); this.#proc?.stdin?.end(); this.#proc?.kill(); }
}
