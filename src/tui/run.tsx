/** Bootstrap da TUI: Ink é carregado por import dinâmico só neste comando. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { redactSecrets } from "../sanitize-external";
import { createApprovalBridge } from "./approvals";
import { createShellRunner } from "./shell";
import { loadTuiConfig } from "./theme";

export interface RunTuiOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Ink desmontaria no ctrl+c antes do handler da app; a app decide a saída. */
export const TUI_RENDER_OPTIONS = { exitOnCtrlC: false } as const;

/** Aplica o último modelo gravado; modelo removido da config é ignorado. */
export function applySavedModel(session: { setModel(ref: string): string }, cwd: string): string | undefined {
  const saved = loadTuiConfig(cwd).lastModel;
  if (saved === undefined) return undefined;
  try {
    return session.setModel(saved);
  } catch {
    return undefined;
  }
}

/** Branch git do cwd; ausente fora de um repositório. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" || out === "HEAD" ? undefined : out;
  } catch {
    return undefined;
  }
}

export async function runTui(opts: RunTuiOptions): Promise<number> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error("erro: tui precisa de um terminal interativo; use `chat` para stdin em pipe");
    return 1;
  }
  try {
    const [{ render }, { AgentSession }, { SessionStore }, { TuiApp }] = await Promise.all([
      import("ink"),
      import("../chat/agent-session"),
      import("../chat/store"),
      import("./app"),
    ]);
    const cwd = resolve(opts.cwd);
    const approvals = createApprovalBridge();
    const shell = createShellRunner({ configPath: resolve(opts.configPath), cwd, env: opts.env ?? process.env });
    const session = new AgentSession({
      configPath: resolve(opts.configPath), cwd, env: opts.env ?? process.env,
      approveSwap: approvals.approveSwap,
      onBudgetExceeded: approvals.onBudgetExceeded,
    });
    applySavedModel(session, cwd);
    const store = new SessionStore(resolve(cwd, ".astro", "sessions"));
    let instance: ReturnType<typeof render> | undefined;
    const branch = gitBranch(cwd);
    try {
      instance = render(
        <TuiApp
          session={session}
          cwd={cwd}
          {...(branch === undefined ? {} : { branch })}
          store={store}
          approvals={approvals}
          shell={shell}
          onExit={() => instance?.unmount()}
        />,
        TUI_RENDER_OPTIONS,
      );
      await instance.waitUntilExit();
      return 0;
    } finally {
      try {
        session.close();
      } catch {
        // turno abortado ainda em curso: o sinal já foi enviado
      }
    }
  } catch (error) {
    console.error(`erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}
