/** Bootstrap da TUI: Ink é carregado por import dinâmico só neste comando. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { redactSecrets } from "../sanitize-external";

export interface RunTuiOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
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
    const session = new AgentSession({ configPath: resolve(opts.configPath), cwd, env: opts.env ?? process.env });
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
          onExit={() => instance?.unmount()}
        />,
      );
      await instance.waitUntilExit();
      return 0;
    } finally {
      session.close();
    }
  } catch (error) {
    console.error(`erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}
