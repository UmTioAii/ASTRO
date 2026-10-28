/** `!cmd` da TUI: executa via run_command com allowlist, sandbox e timeout. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Auditor } from "../audit";
import { loadConfig } from "../config";
import { redactSecrets } from "../sanitize-external";
import { ToolExecutor } from "../tools/executor";
import { configureRunCommand, runCommandTool } from "../tools/run-command";

export interface ShellResult {
  output: string;
  isError: boolean;
}

export interface ShellRunner {
  readonly enabled: boolean;
  run(command: string, signal?: AbortSignal): Promise<ShellResult>;
}

export interface ShellOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Variáveis que o shell precisa manter mesmo se um MCP declarar o mesmo nome. */
const SYSTEM_ENV = new Set([
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "SHELL", "PWD", "LANG", "LC_ALL", "TERM",
]);

/**
 * Cria o executor de `!cmd`. Sem `run_command` em `agent.tools` o runner fica
 * desabilitado (I-01); sandbox e timeout vêm da config e da manifest.
 */
export function createShellRunner(opts: ShellOptions): ShellRunner {
  const config = loadConfig(opts.configPath);
  if (!config.agent.tools.includes("run_command")) {
    return {
      enabled: false,
      run: async () => ({ output: "run_command não está na allowlist de agent.tools", isError: true }),
    };
  }
  configureRunCommand({ sandbox: config.tools?.run_command?.sandbox ?? false });
  const auditPath = resolve(opts.cwd, config.paths.audit);
  const secretEnvNames: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if (provider.kind === "openai-compat" && typeof provider.credentialRef === "string") {
      secretEnvNames.push(provider.credentialRef);
    }
  }
  for (const server of Object.values(config.mcpServers ?? {})) {
    for (const name of Object.keys(server.env ?? {})) {
      if (!SYSTEM_ENV.has(name.toUpperCase())) secretEnvNames.push(name);
    }
  }
  return {
    enabled: true,
    run: async (command, signal) => {
      const input = command.trim();
      if (input === "") return { output: "uso: !<comando>", isError: true };
      // Auditor novo por execução: o seq é local e não colide com a sessão.
      const executor = new ToolExecutor({
        tools: [runCommandTool],
        allow: ["run_command"],
        audit: new Auditor(auditPath),
      });
      try {
        const result = await executor.run(
          {
            cwd: opts.cwd, run: randomUUID(), agent: "default",
            env: opts.env ?? process.env, secretEnvNames,
            ...(signal === undefined ? {} : { signal }),
          },
          { id: randomUUID(), name: "run_command", arguments: JSON.stringify({ command: input }) },
        );
        return { output: redactSecrets(result.output), isError: result.isError === true };
      } catch (error) {
        return {
          output: redactSecrets(error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
    },
  };
}
