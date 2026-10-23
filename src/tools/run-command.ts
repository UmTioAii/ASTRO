import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ToolError, type Tool, type ToolResult } from "./types";

const MAX_OUTPUT = 10_000;
const DOCKER_IMAGE = "alpine:3";

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

// --- Sandbox (F4-6) ---

let sandboxEnabled = false;
let dockerProbe: Promise<boolean> | undefined;

/**
 * Verifica se o binário `docker` existe e o daemon responde (`docker info`).
 * Resultado cacheado por processo.
 */
export function detectDockerAvailable(): Promise<boolean> {
  if (dockerProbe === undefined) {
    dockerProbe = (async () => {
      try {
        const proc = Bun.spawn({
          cmd: ["docker", "info", "--format", "{{.ServerVersion}}"],
          stdout: "pipe",
          stderr: "pipe",
          env: minimalHostEnv(),
        });
        const timer = setTimeout(() => proc.kill(), 5_000);
        try {
          const code = await proc.exited;
          return code === 0;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return false;
      }
    })();
  }
  return dockerProbe;
}

/** Env mínimo para spawnar o docker CLI: sem credenciais do host. */
function minimalHostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SYSTEMROOT !== undefined) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

/** Configura o modo sandbox de run_command (chamado pelo app ao carregar a config). */
export function configureRunCommand(opts: { sandbox?: boolean }): void {
  sandboxEnabled = opts.sandbox === true;
}

/** Argv do docker run com isolamento: rede off, rootfs read-only, cwd read-write. */
function dockerArgv(containerName: string, cwd: string, command: string): string[] {
  const workdir = resolve(cwd);
  return [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--volume",
    `${workdir}:${workdir}`,
    "--workdir",
    workdir,
    DOCKER_IMAGE,
    "sh",
    "-c",
    command,
  ];
}

/** Executa um comando dentro do container Docker efêmero. */
async function runInDocker(command: string, ctx: { cwd: string }, timeoutMs: number): Promise<ToolResult> {
  const containerName = `astro-sb-${randomUUID().slice(0, 12)}`;
  const proc = Bun.spawn({
    cmd: dockerArgv(containerName, ctx.cwd, command),
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: minimalHostEnv(),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  const timeout = new Promise<typeof timedOut>((res) => {
    timer = setTimeout(() => {
      proc.kill();
      res(timedOut);
    }, timeoutMs);
  });

  let exited: typeof timedOut | number;
  try {
    exited = await Promise.race([proc.exited, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (exited === timedOut) {
    // docker run morto não para o container: limpeza forçada best-effort
    try {
      Bun.spawn({
        cmd: ["docker", "rm", "-f", containerName],
        stdout: "ignore",
        stderr: "ignore",
        env: minimalHostEnv(),
      });
    } catch {
      // best-effort
    }
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const chunks = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0);
  let output = chunks.join("\n");

  if (exited === timedOut) {
    const note = `timeout de ${timeoutMs}ms excedido no sandbox; container interrompido`;
    output = output.length > 0 ? `${output}\n${note}` : note;
    return { output: truncate(output), isError: true };
  }
  if (exited !== 0) {
    const note = `comando terminou com código ${exited} (sandbox docker)`;
    output = output.length > 0 ? `${output}\n${note}` : note;
    return { output: truncate(output), isError: true };
  }
  return { output: truncate(output) };
}

/** Executa um comando de shell no diretório de trabalho, com timeout do manifesto. */
export const runCommandTool: Tool = {
  manifest: {
    name: "run_command",
    description:
      "Executa um comando de shell no diretório de trabalho e devolve a saída. " +
      "Com tools.run_command.sandbox ativo, executa em container Docker efêmero " +
      "isolado (sem rede, rootfs read-only, cwd read-write).",
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

    // Sandbox: container Docker efêmero; sem Docker disponível, recusa (sem downgrade)
    if (sandboxEnabled) {
      const docker = await detectDockerAvailable();
      if (!docker) {
        return failure(
          "sandbox ativo (tools.run_command.sandbox) mas Docker não está disponível; " +
            "instale e inicie o Docker ou desative o sandbox na configuração",
        );
      }
      try {
        return await runInDocker(command, ctx, runCommandTool.manifest.timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`erro no sandbox docker: ${message}`);
      }
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