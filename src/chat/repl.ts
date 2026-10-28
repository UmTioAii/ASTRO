/** REPL mínimo do chat (T1): I/O injetável e comandos; a UI só fala com a sessão. */
import { HELP_TEXT, parseCommand } from "./commands";
import type { ProviderInfo, SessionSnapshot, TurnResult } from "./agent-session";
import type { SessionStore } from "./store";
import { isFatalSessionError } from "./session-errors";
import { redactSecrets } from "../sanitize-external";

export interface ReplIO {
  read(prompt: string): Promise<string | null>;
  /** Lê só uma linha nova (ignora a fila do REPL); para decisores no meio do turno. */
  readFresh?(prompt: string): Promise<string | null>;
  write(text: string): void;
}

export interface ChatSession {
  readonly model: string;
  send(prompt: string, signal?: AbortSignal): Promise<TurnResult>;
  clear(): void;
  setModel(ref: string): string;
  listModels(): string[];
  listProviders(): ProviderInfo[];
  setProvider(name: string): string;
  snapshot(): SessionSnapshot;
  close(): void;
}

export interface ReplOptions {
  store?: SessionStore;
  signal?: AbortSignal;
  /** Cores ANSI apenas quando o I/O é um terminal. */
  style?: boolean;
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function fmtCost(value: number | null): string {
  return value === null ? "n/d" : `US$ ${value.toFixed(6)}`;
}

const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

function paint(text: string, code: string, style: boolean): string {
  return style ? `${code}${text}${RESET}` : text;
}

export function sessionLines(snapshot: SessionSnapshot, lastFile: string | undefined): string[] {
  const line = `sessão ${snapshot.id} · início ${snapshot.startedAt} · modelo ${snapshot.model}`
    + ` · turnos ${snapshot.turns} · tokens ${snapshot.tokensIn}/${snapshot.tokensOut}`
    + ` · custo ${fmtCost(snapshot.costUsd)}`;
  return [line, `arquivo: ${lastFile ?? "ainda não salvo"}`];
}

export function providerLine(provider: ProviderInfo): string {
  const credential = provider.credentialRef === undefined ? "" : ` cred=${provider.credentialRef}`;
  return `${provider.name} (${provider.kind})${credential} quota=${provider.quotaDomain} models=${provider.models.join(",") || "-"}`;
}

export function statusLine(result: TurnResult): string {
  const note = [result.warning ? "⚠ contexto ≥80%" : "", result.trimmed ? "turno antigo descartado" : ""]
    .filter((item) => item !== "").join(" · ");
  const totals = `total ${result.totalTokensIn}/${result.totalTokensOut} · ${fmtCost(result.totalCostUsd)}`;
  return `[${result.model}] ${result.steps} step(s) · ${result.tokensIn}/${result.tokensOut} tokens · ${totals}${note === "" ? "" : ` · ${note}`}`;
}

/** Executa o REPL até `/exit`, EOF ou erro fatal; sempre fecha a sessão. */
export async function runRepl(session: ChatSession, io: ReplIO, opts: ReplOptions = {}): Promise<void> {
  const style = opts.style === true;
  let lastFile: string | undefined;
  let lastPersistError: string | undefined;
  const persist = (report = false): string | undefined => {
    if (opts.store === undefined) return undefined;
    try {
      lastFile = opts.store.write(session.snapshot());
      lastPersistError = undefined;
      return lastFile;
    } catch (error) {
      const message = messageOf(error);
      if (report || message !== lastPersistError) io.write(paint(`erro: ${message}`, RED, style));
      lastPersistError = message;
      lastFile = undefined;
      return undefined;
    }
  };
  io.write(paint("astro chat - /help para comandos, /exit para sair", DIM, style));
  try {
    for (;;) {
      const line = await io.read("astro> ");
      if (line === null) break;
      const command = parseCommand(line);
      if (command.kind === "empty") continue;
      if (command.kind === "exit") break;
      if (command.kind === "help") {
        io.write(HELP_TEXT);
        continue;
      }
      if (command.kind === "unknown") {
        io.write(`comando desconhecido: /${command.raw}`);
        continue;
      }
      if (command.kind === "providers") {
        io.write(session.listProviders().map(providerLine).join("\n"));
        continue;
      }
      if (command.kind === "provider") {
        if (command.provider === undefined) {
          io.write(session.listProviders().map(providerLine).join("\n"));
          continue;
        }
        try {
          io.write(`provider: ${session.setProvider(command.provider)}`);
        } catch (error) {
          io.write(`erro: ${messageOf(error)}`);
        }
        continue;
      }
      if (command.kind === "session") {
        const lines = sessionLines(session.snapshot(), lastFile);
        if (opts.store === undefined) lines[1] = "arquivo: sem persistência";
        io.write(lines.join("\n"));
        continue;
      }
      if (command.kind === "save") {
        if (opts.store === undefined) {
          io.write("sem persistência configurada");
          continue;
        }
        const saved = persist(true);
        if (saved !== undefined) io.write(`sessão salva em ${saved}`);
        continue;
      }
      if (command.kind === "clear") {
        session.clear();
        io.write("contexto limpo");
        continue;
      }
      if (command.kind === "model") {
        if (command.model === undefined) {
          io.write(session.listModels().join("\n"));
          continue;
        }
        try {
          io.write(`modelo: ${session.setModel(command.model)}`);
        } catch (error) {
          io.write(`erro: ${messageOf(error)}`);
        }
        continue;
      }
      try {
        const result = await session.send(command.text, opts.signal);
        io.write(result.final);
        io.write(paint(statusLine(result), DIM, style));
      } catch (error) {
        io.write(paint(`erro: ${messageOf(error)}`, RED, style));
        if (isFatalSessionError(error)) break;
      } finally {
        persist();
      }
    }
  } finally {
    session.close();
    persist();
  }
}
