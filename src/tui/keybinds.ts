/** Keybindings da TUI (T2): leader `ctrl+x`; puro, sem React e sem I/O. */
import type { ChatSession } from "../chat/repl";
import { sessionSummaryLine, type SessionStore } from "../chat/store";
import { redactSecrets } from "../sanitize-external";
import type { Entry } from "./commands";
import { nextTheme, type Theme } from "./theme";

export const LEADER = "ctrl+x";

export interface KeybindContext {
  session: Pick<ChatSession, "clear" | "listModels">;
  store?: Pick<SessionStore, "list">;
  theme: Theme;
  addEntries(entries: Entry[]): void;
  setTheme(theme: Theme): void;
  finish(): void;
}

function clearContext(context: KeybindContext): void {
  context.session.clear();
  context.addEntries([{ kind: "info", text: "contexto limpo" }]);
}

function listSessions(context: KeybindContext): void {
  const sessions = context.store?.list();
  if (sessions === undefined) {
    context.addEntries([{ kind: "info", text: "sem persistência configurada" }]);
    return;
  }
  const text = sessions.length === 0 ? "nenhuma sessão salva" : sessions.map((item, index) => sessionSummaryLine(item, index)).join("\n");
  context.addEntries([{ kind: "info", text }]);
}

function toggleTheme(context: KeybindContext): void {
  const theme = nextTheme(context.theme);
  context.setTheme(theme);
  context.addEntries([{ kind: "info", text: `tema: ${theme}` }]);
}

export const KEYBINDS: Record<string, { description: string; run(context: KeybindContext): void }> = {
  [`${LEADER} c`]: { description: "limpar o contexto", run: clearContext },
  [`${LEADER} e`]: { description: "sair", run: (context) => context.finish() },
  [`${LEADER} q`]: { description: "sair", run: (context) => context.finish() },
  [`${LEADER} m`]: {
    description: "listar modelos",
    run: (context) => context.addEntries([{ kind: "info", text: context.session.listModels().join("\n") }]),
  },
  [`${LEADER} n`]: { description: "nova conversa", run: clearContext },
  [`${LEADER} l`]: { description: "listar sessões", run: listSessions },
  [`${LEADER} t`]: { description: "alternar tema", run: toggleTheme },
};

/** Executa a combinação; devolve `false` quando ela não existe. */
export function runKeybind(key: string, context: KeybindContext): boolean {
  const action = KEYBINDS[key.toLowerCase()];
  if (action === undefined) return false;
  try {
    action.run(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.addEntries([{ kind: "error", text: `erro: ${redactSecrets(message)}` }]);
  }
  return true;
}
