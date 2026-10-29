/** REPL mínimo do chat (T1): I/O injetável e comandos; a UI só fala com a sessão. */
import { HELP_TEXT, parseCommand } from "./commands";
import type { ProviderInfo, SessionSnapshot, TurnResult } from "./agent-session";
import type { SessionStore } from "./store";
import { sessionSummaryLine } from "./store";
import { exportSession } from "./export";
import { initAgents } from "./init";
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
  send(prompt: string, signal?: AbortSignal, onToken?: (text: string) => void): Promise<TurnResult>;
  compact(): Promise<string>;
  clear(): void;
  resume(snapshot: SessionSnapshot): void;
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
  /** Diretório para `/export` e `/init` (I-11); default é o processo. */
  cwd?: string;
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

/** Duração desde `startedAt`; datas inválidas viram "desconhecido". */
export function formatUptime(startedAt: string, now = Date.now()): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "desconhecido";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? "desconhecido" : model.slice(0, slash);
}

/** Metadados da sessão para `/session` e `/details` (mesmo formatter nas duas superfícies). */
export function detailsLines(snapshot: SessionSnapshot, lastFile: string | undefined, now = Date.now()): string[] {
  return [
    `sessão ${snapshot.id} · início ${snapshot.startedAt} · uptime ${formatUptime(snapshot.startedAt, now)}`,
    `provider: ${providerOf(snapshot.model)} · modelo ${snapshot.model} · turnos ${snapshot.turns}`
      + ` · tokens ${snapshot.tokensIn}/${snapshot.tokensOut} · custo ${fmtCost(snapshot.costUsd)}`,
    ...(snapshot.resumedFrom === undefined
      ? []
      : [`retomada de ${snapshot.resumedFrom.id} (início ${snapshot.resumedFrom.startedAt})`]),
    `arquivo: ${lastFile ?? "ainda não salvo"}`,
  ];
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
  const cwd = opts.cwd ?? process.cwd();
  let lastFile: string | undefined;
  let lastPersistError: string | undefined;
  let storeList: ReturnType<SessionStore["list"]> = [];
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
      if (command.kind === "session" || command.kind === "details") {
        const lines = detailsLines(session.snapshot(), lastFile);
        if (opts.store === undefined) lines[lines.length - 1] = "arquivo: sem persistência";
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
      if (command.kind === "sessions") {
        if (opts.store === undefined) {
          io.write("sem persistência configurada");
          continue;
        }
        storeList = opts.store.list();
        io.write(storeList.length === 0
          ? "nenhuma sessão salva"
          : storeList.map((item, index) => sessionSummaryLine(item, index)).join("\n"));
        continue;
      }
      if (command.kind === "resume") {
        if (opts.store === undefined) {
          io.write("sem persistência configurada");
          continue;
        }
        if (command.ref === undefined) {
          io.write("uso: /resume <número|id> (veja /sessions)");
          continue;
        }
        try {
          let chosen: (typeof storeList)[number] | undefined;
          if (/^\d+$/.test(command.ref)) {
            if (storeList.length === 0) storeList = opts.store.list();
            chosen = storeList[Number(command.ref) - 1];
            if (chosen === undefined) {
              io.write("índice fora da lista; use /sessions");
              continue;
            }
          } else {
            chosen = storeList.find((item) => item.id === command.ref);
          }
          const loaded = chosen === undefined ? opts.store.load(command.ref) : opts.store.load(chosen.id);
          session.resume(loaded.record);
          lastFile = loaded.path;
          io.write(`sessão retomada: ${loaded.record.id} (${loaded.record.turns} turnos)`);
        } catch (error) {
          io.write(`erro: ${messageOf(error)}`);
        }
        continue;
      }
      if (command.kind === "export") {
        try {
          const path = exportSession(session.snapshot(), cwd, command.path);
          io.write(`sessão exportada em ${path}`);
        } catch (error) {
          io.write(`erro: ${messageOf(error)}`);
        }
        continue;
      }
      if (command.kind === "init") {
        try {
          io.write(`AGENTS.md criado em ${initAgents(cwd)}`);
        } catch (error) {
          io.write(`erro: ${messageOf(error)}`);
        }
        continue;
      }
      if (command.kind === "clear") {
        session.clear();
        io.write("contexto limpo");
        continue;
      }
      if (command.kind === "compact") {
        try {
          const summary = await session.compact();
          io.write(summary);
        } catch (error) {
          io.write(`erro: ${messageOf(error)}`);
        }
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
