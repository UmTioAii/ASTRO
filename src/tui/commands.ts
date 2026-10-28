/** Comandos de barra compartilhados pelo REPL e pela TUI: puro, sem React. */
import { HELP_TEXT, type ReplCommand } from "../chat/commands";
import { providerLine, sessionLines, type ChatSession } from "../chat/repl";
import type { SessionStore } from "../chat/store";
import { redactSecrets } from "../sanitize-external";

export type EntryKind = "user" | "assistant" | "info" | "error";

export interface Entry {
  kind: EntryKind;
  text: string;
}

export interface CommandState {
  lastFile?: string;
}

export interface CommandOutcome {
  entries: Entry[];
  exit?: boolean;
  lastFile?: string;
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
    case "session": {
      const lines = sessionLines(session.snapshot(), state.lastFile);
      if (store === undefined) lines[1] = "arquivo: sem persistência";
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
        return { entries: [{ kind: "error", text: `erro: ${messageOf(error)}` }] };
      }
    }
  }
}

function providerLines(session: ChatSession): string {
  const providers = session.listProviders();
  if (providers.length === 0) return "nenhum provider configurado";
  return providers.map(providerLine).join("\n");
}
