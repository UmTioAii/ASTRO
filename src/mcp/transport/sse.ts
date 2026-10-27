import { MCPError } from "../types";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Transport SSE legacy do MCP (#56): GET abre o stream e recebe o evento
 * `endpoint`; respostas chegam pelo stream, correlacionadas por id.
 */
export class SseTransport {
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #abort = new AbortController();
  readonly #pending = new Map<number, Pending>();
  #endpoint: string | undefined;
  #nextId = 1;
  #closed = false;

  private constructor(opts: { url: string; headers?: Record<string, string>; timeoutMs: number }) {
    this.#baseUrl = opts.url;
    this.#headers = opts.headers ?? {};
    this.#timeoutMs = opts.timeoutMs;
  }

  static async connect(opts: { url: string; headers?: Record<string, string>; timeoutMs: number }): Promise<SseTransport> {
    const transport = new SseTransport(opts);
    const endpointReady = new Promise<void>((resolve, reject) => {
      transport.#endpointTimer = setTimeout(() => {
        transport.#endpointTimer = undefined;
        transport.#endpointTimeoutError = new MCPError(`timeout de ${opts.timeoutMs}ms aguardando endpoint SSE`);
        transport.#abort.abort(); // encerra o fetch/stream pendente junto
        reject(transport.#endpointTimeoutError);
      }, opts.timeoutMs);
      transport.#onEndpoint = () => {
        if (transport.#endpointTimer !== undefined) clearTimeout(transport.#endpointTimer);
        transport.#endpointTimer = undefined;
        resolve();
      };
    });
    endpointReady.catch(() => {}); // tratado abaixo: evita rejeição órfã em corrida
    try {
      const response = await fetch(opts.url, { headers: { accept: "text/event-stream", ...opts.headers }, signal: transport.#abort.signal });
      if (!response.ok) throw new MCPError(`HTTP ${response.status} abrindo stream SSE do MCP`);
      void transport.#pump(response);
    } catch (error) {
      if (transport.#endpointTimer !== undefined) clearTimeout(transport.#endpointTimer);
      transport.close();
      if (transport.#endpointTimeoutError !== undefined) throw transport.#endpointTimeoutError;
      if (error instanceof MCPError) throw error;
      throw new MCPError(`falha ao conectar no MCP SSE: ${error instanceof Error ? error.message : String(error)}`);
    }
    await endpointReady;
    return transport;
  }

  #onEndpoint: () => void = () => {};
  #endpointTimer: ReturnType<typeof setTimeout> | undefined;
  #endpointTimeoutError: MCPError | undefined;

  async #pump(response: Response): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += new TextDecoder().decode(chunk as Uint8Array, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          this.#handleBlock(block);
        }
      }
    } catch {
      // stream encerrado/abortado: pendências são rejeitadas abaixo
    }
    this.#failAll(new MCPError("stream SSE do MCP encerrou"));
  }

  #handleBlock(block: string): void {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    if (event === "endpoint" && data.length > 0) {
      this.#endpoint = new URL(data, this.#baseUrl).toString();
      this.#onEndpoint();
      return;
    }
    if (data.length === 0) return;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) pending.reject(new MCPError(message.error.message || "erro do servidor MCP"));
    else pending.resolve(message.result);
  }

  #failAll(error: MCPError): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed || this.#endpoint === undefined) throw new MCPError("transport MCP fechado");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MCPError(`timeout de ${this.#timeoutMs}ms no MCP ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      void fetch(this.#endpoint!, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: this.#abort.signal,
      }).catch((error: unknown) => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new MCPError(`falha ao enviar no MCP: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.#closed || this.#endpoint === undefined) return;
    void fetch(this.#endpoint, { method: "POST", headers: { "content-type": "application/json", ...this.#headers }, body: JSON.stringify({ jsonrpc: "2.0", method, params }), signal: this.#abort.signal }).catch(() => {});
  }

  close(): void { this.#abort.abort(); this.#failAll(new MCPError("transport MCP fechado")); }
}
