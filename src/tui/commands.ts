/** Comandos de barra compartilhados pelo REPL e pela TUI: puro, sem React. */
import { HELP_TEXT, type ReplCommand } from "../chat/commands";
import { providerLine, sessionLines, type ChatSession } from "../chat/repl";
import { sessionSummaryLine, type SessionStore, type SessionSummary } from "../chat/store";
import { redactSecrets } from "../sanitize-external";
import { exportSession } from "../chat/export";
import { initAgents } from "../chat/init";

export type EntryKind = "user" | "assistant" | "info" | "error";

export interface Entry {
  kind: EntryKind;
  text: string;
}

export interface CommandState {
  lastFile?: string;
  sessions?: SessionSummary[];
}

export interface CommandOutcome {
  entries: Entry[];
  exit?: boolean;
  /** Caminho gravado; `null` quando a gravação falhou (limpa o anterior). */
  lastFile?: string | null;
}

type SlashCommand = Exclude<ReplCommand, { kind: "prompt" } | { kind: "empty" }>;

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Executa um comando que não é turno; devolve entradas para a UI renderizar. */
export function runCommand(
  command: SlashCommand,
  session: ChatSession,
  state: CommandState,
  store?: SessionStore,
  cwd = process.cwd(),
): CommandOutcome {
  switch (command.kind) {
    case "help":
      return { entries: [{ kind: "info", text: HELP_TEXT }] };
    case "clear":
      session.clear();
      return { entries: [{ kind: "info", text: "contexto limpo" }] };
    case "exit":
      return { entries: [], exit: true };
    case "unknown":
      return { entries: [{ kind: "info", text: `comando desconhecido: /${command.raw}` }] };
    case "model": {
      if (command.model === undefined) {
        return { entries: [{ kind: "info", text: session.listModels().join("\n") }] };
      }
      try {
        return { entries: [{ kind: "info", text: `modelo: ${session.setModel(command.model)}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "providers":
      return { entries: [{ kind: "info", text: providerLines(session) }] };
    case "provider": {
      if (command.provider === undefined) {
        return { entries: [{ kind: "info", text: providerLines(session) }] };
      }
      try {
        return { entries: [{ kind: "info", text: `provider: ${session.setProvider(command.provider)}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "sessions": {
      if (store === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      const sessions = store.list();
      state.sessions = sessions;
      return {
        entries: [{
          kind: "info",
          text: sessions.length === 0
            ? "nenhuma sessão salva"
            : sessions.map((item, index) => sessionSummaryLine(item, index)).join("\n"),
        }],
      };
    }
    case "resume": {
      if (store === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      if (command.ref === undefined) {
        return { entries: [{ kind: "info", text: "uso: /resume <número|id> (veja /sessions)" }] };
      }
      try {
        let chosen: SessionSummary | undefined;
        if (/^\d+$/.test(command.ref)) {
          if (state.sessions === undefined || state.sessions.length === 0) state.sessions = store.list();
          chosen = state.sessions[Number(command.ref) - 1];
          if (chosen === undefined) {
            return { entries: [{ kind: "info", text: "índice fora da lista; use /sessions" }] };
          }
        } else {
          chosen = state.sessions?.find((item) => item.id === command.ref);
        }
        const loaded = chosen === undefined ? store.load(command.ref) : store.load(chosen.id);
        session.resume(loaded.record);
        state.lastFile = loaded.path;
        return {
          entries: [{ kind: "info", text: `sessão retomada: ${loaded.record.id} (${loaded.record.turns} turnos)` }],
          lastFile: loaded.path,
        };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "export": {
      try {
        const path = exportSession(session.snapshot(), cwd, command.path);
        return { entries: [{ kind: "info", text: `sessão exportada em ${path}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "init": {
      try {
        const path = initAgents(cwd);
        return { entries: [{ kind: "info", text: `AGENTS.md criado em ${path}` }] };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
    case "session": {
      const lines = sessionLines(session.snapshot(), state.lastFile);
      if (store === undefined) lines[lines.length - 1] = "arquivo: sem persistência";
      return { entries: [{ kind: "info", text: lines.join("\n") }] };
    }
    case "save": {
      if (store === undefined) {
        return { entries: [{ kind: "info", text: "sem persistência configurada" }] };
      }
      try {
        const path = store.write(session.snapshot());
        return { entries: [{ kind: "info", text: `sessão salva em ${path}` }], lastFile: path };
      } catch (error) {
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }], lastFile: null };
      }
    }
  }
}

function providerLines(session: ChatSession): string {
  const providers = session.listProviders();
  if (providers.length === 0) return "nenhum provider configurado";
  return providers.map(providerLine).join("\n");
}

