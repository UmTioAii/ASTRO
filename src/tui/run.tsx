/** Bootstrap da TUI: Ink é carregado por import dinâmico só neste comando. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, loadConfig } from "../config";
import { ProfileManager } from "../provider/profile-manager";
import { NoProviderError, NO_PROVIDER_MESSAGE } from "../provider/profiles";
import { redactSecrets } from "../sanitize-external";
import { createApprovalBridge } from "./approvals";
import { createShellRunner } from "./shell";
import { getThemeColors, loadTuiConfig } from "./theme";

export interface RunTuiOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  allowMissingConfig?: boolean;
}

/** Ink desmontaria no ctrl+c antes do handler da app; a app decide a saída. */
export const TUI_RENDER_OPTIONS = { exitOnCtrlC: false } as const;

/** Abre a sessão já com o último modelo; modelo removido da config cai no default. */
export function openSession<T>(create: (model?: string) => T, cwd: string): T {
  const saved = loadTuiConfig(cwd).lastModel;
  if (saved === undefined) return create();
  try {
    return create(saved);
  } catch (error) {
    if (error instanceof ConfigError) return create();
    throw error;
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

/**
 * Primeiro run: tenta criar a sessão. Só quando falta provider e a config é
 * implícita abre o setup; qualquer outro erro segue o caminho normal.
 */
export async function withProviderSetup<T>(
  create: () => T,
  setup: () => Promise<boolean>,
  allowMissingConfig: boolean,
): Promise<T | undefined> {
  try {
    return create();
  } catch (error) {
    if (!allowMissingConfig || !(error instanceof NoProviderError)) throw error;
    if (!(await setup())) return undefined;
    return create();
  }
}

/** Tela de providers standalone; resolve true quando um perfil foi ativado. */
export async function setupProvider(manager: ProfileManager, cwd: string): Promise<boolean> {
  const [{ render }, { ProviderScreen }] = await Promise.all([
    import("ink"),
    import("./provider-screen"),
  ]);
  const colors = getThemeColors(loadTuiConfig(cwd).theme);
  return await new Promise<boolean>((resolveSetup) => {
    let instance: ReturnType<typeof render> | undefined;
    let settled = false;
    const finish = (configured: boolean): void => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolveSetup(configured);
    };
    instance = render(
      <ProviderScreen
        manager={manager}
        colors={colors}
        onClose={() => finish(false)}
        onActivate={() => finish(true)}
        onChanged={() => undefined}
      />,
      TUI_RENDER_OPTIONS,
    );
  });
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
    const shell = createShellRunner({
      configPath: resolve(opts.configPath), cwd, env: opts.env ?? process.env,
      allowMissingConfig: opts.allowMissingConfig === true,
    });
    const configPath = resolve(opts.configPath);
    const project = existsSync(configPath) ? loadConfig(configPath) : undefined;
    const manager = new ProfileManager({
      project,
      env: opts.env ?? process.env,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    });
    const createSession = (model?: string) => new AgentSession({
      configPath, cwd, env: opts.env ?? process.env,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      allowMissingConfig: opts.allowMissingConfig === true,
      approveSwap: approvals.approveSwap,
      onBudgetExceeded: approvals.onBudgetExceeded,
      ...(model === undefined ? {} : { model }),
    });
    // `--provider` explícito vence o último modelo salvo em .astro/tui.json.
    const session = await withProviderSetup(
      () => (opts.provider === undefined ? openSession(createSession, cwd) : createSession()),
      () => setupProvider(manager, cwd),
      opts.allowMissingConfig === true,
    );
    if (session === undefined) {
      console.error(`erro: ${NO_PROVIDER_MESSAGE}`);
      return 1;
    }
    for (const warning of session.warnings) console.error(`aviso: ${warning}`);
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
          manager={manager}
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
