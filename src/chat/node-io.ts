/** I/O do REPL via readline (fila de linhas; SIGINT aborta o turno e encerra). */
import { createInterface } from "node:readline";
import type { ReplIO } from "./repl";

export interface NodeReplIO extends ReplIO {
  close(): void;
  signal: AbortSignal;
}

export function nodeReplIO(): NodeReplIO {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const controller = new AbortController();
  const pending: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  rl.on("SIGINT", () => {
    controller.abort(new Error("cancelado"));
    rl.close();
  });
  return {
    signal: controller.signal,
    read: async (prompt) => {
      process.stdout.write(prompt);
      const line = pending.shift();
      if (line !== undefined) return line;
      if (closed) return null;
      return await new Promise<string | null>((resolve) => waiters.push(resolve));
    },
    /** Ignora linhas já enfileiradas: decisor no meio do turno espera resposta nova. */
    readFresh: async (prompt) => {
      process.stdout.write(prompt);
      if (closed) return null;
      return await new Promise<string | null>((resolve) => waiters.push(resolve));
    },
    write: (text) => console.log(text),
    close: () => {
      if (!closed) rl.close();
      closed = true;
    },
  };
}
