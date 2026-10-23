import { ToolError, type Tool, type ToolResult } from "./types";

const MAX_OUTPUT = 10_000;

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

function commandInput(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { command }");
  }
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ToolError("entrada inválida: \"command\" deve ser uma string não vazia");
  }
  return command;
}

function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) : text;
}

/** Executa um comando de shell no diretório de trabalho, com timeout do manifesto. */
export const runCommandTool: Tool = {
  manifest: {
    name: "run_command",
    description: "Executa um comando de shell no diretório de trabalho e devolve a saída.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Comando a executar no shell do sistema.",
        },
      },
      required: ["command"],
    },
    risk: "high",
    permission: "execute",
    timeoutMs: 30_000,
    retryable: false,
  },

  async execute(input, ctx): Promise<ToolResult> {
    let command: string;
    try {
      command = commandInput(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(message);
    }

    try {
      const proc = Bun.spawn({
        cmd: shellArgv(command),
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timeout");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => {
          proc.kill();
          resolve(timedOut);
        }, runCommandTool.manifest.timeoutMs);
      });

      let exited: typeof timedOut | number;
      try {
        exited = await Promise.race([proc.exited, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const chunks = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0);
      let output = chunks.join("\n");

      if (exited === timedOut) {
        const note = `timeout de ${runCommandTool.manifest.timeoutMs}ms excedido; comando interrompido`;
        output = output.length > 0 ? `${output}\n${note}` : note;
        return { output: truncate(output), isError: true };
      }

      if (exited !== 0) {
        const note = `comando terminou com código ${exited}`;
        output = output.length > 0 ? `${output}\n${note}` : note;
        return { output: truncate(output), isError: true };
      }

      return { output: truncate(output) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao executar comando: ${message}`);
    }
  },
};
