/** TUI (T2): conversa, entrada e status bar. Consome apenas a ChatSession. */
import { Box, Static, Text, useInput } from "ink";
import { useRef, useState, type ReactElement } from "react";
import { parseCommand } from "../chat/commands";
import { statusLine, type ChatSession } from "../chat/repl";
import type { SessionStore } from "../chat/store";
import type { SessionSnapshot } from "../chat/agent-session";
import { isFatalSessionError } from "../chat/session-errors";
import { redactSecrets } from "../sanitize-external";
import { runCommand, type Entry } from "./commands";

export interface TuiAppProps {
  session: ChatSession;
  cwd: string;
  branch?: string;
  store?: SessionStore;
  onExit?: () => void;
}

interface Status {
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

const WELCOME = "astro tui · /help para comandos · /exit para sair";

function statusOf(snapshot: SessionSnapshot): Status {
  return {
    model: snapshot.model,
    turns: snapshot.turns,
    tokensIn: snapshot.tokensIn,
    tokensOut: snapshot.tokensOut,
    costUsd: snapshot.costUsd,
  };
}

function money(value: number | null): string {
  return value === null ? "n/d" : `US$ ${value.toFixed(6)}`;
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function EntryLine({ entry }: { entry: Entry }): ReactElement {
  if (entry.kind === "user") return <Text color="cyan">{"> "}{entry.text}</Text>;
  if (entry.kind === "assistant") return <Text>{entry.text}</Text>;
  if (entry.kind === "error") return <Text color="red">{entry.text}</Text>;
  return <Text dimColor>{entry.text}</Text>;
}

export function TuiApp({ session, cwd, branch, store, onExit }: TuiAppProps): ReactElement {
  const [entries, setEntries] = useState<Entry[]>([{ kind: "info", text: WELCOME }]);
  const [input, setInputState] = useState("");
  const inputRef = useRef("");
  const setInput = (update: (current: string) => string): void => {
    inputRef.current = update(inputRef.current);
    setInputState(inputRef.current);
  };
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const turn = useRef<AbortController | undefined>(undefined);
  const exitRequested = useRef(false);
  const [status, setStatus] = useState<Status>(() => statusOf(session.snapshot()));
  const lastFile = useRef<string | undefined>(undefined);
  const exited = useRef(false);

  const persist = (report: boolean): { path?: string; failed: boolean } => {
    if (store === undefined) return { failed: false };
    try {
      return { path: store.write(session.snapshot()), failed: false };
    } catch (error) {
      if (report) setEntries((current) => [...current, { kind: "error", text: `erro: ${messageOf(error)}` }]);
      return { failed: true };
    }
  };

  const finish = (): void => {
    if (exited.current) return;
    if (busyRef.current) {
      exitRequested.current = true;
      turn.current?.abort();
      return;
    }
    exited.current = true;
    persist(false);
    onExit?.();
  };

  const submit = async (): Promise<void> => {
    const text = inputRef.current.trim();
    if (text === "") return;
    setInput(() => "");
    const command = parseCommand(text);
    if (command.kind === "empty") return;
    if (command.kind === "exit") {
      finish();
      return;
    }
    if (command.kind !== "prompt") {
      const outcome = runCommand(command, session, { lastFile: lastFile.current }, store);
      if (outcome.lastFile !== undefined) lastFile.current = outcome.lastFile ?? undefined;
      setEntries((current) => [...current, ...outcome.entries]);
      setStatus(statusOf(session.snapshot()));
      if (outcome.exit) finish();
      return;
    }
    setEntries((current) => [...current, { kind: "user", text }]);
    busyRef.current = true;
    const controller = new AbortController();
    turn.current = controller;
    setBusy(true);
    try {
      const result = await session.send(command.text, controller.signal);
      setEntries((current) => [
        ...current,
        { kind: "assistant", text: result.final },
        { kind: "info", text: statusLine(result) },
      ]);
    } catch (error) {
      setEntries((current) => [...current, { kind: "error", text: `erro: ${messageOf(error)}` }]);
      if (isFatalSessionError(error)) exitRequested.current = true;
    } finally {
      const saved = persist(true);
      if (saved.failed) lastFile.current = undefined;
      else if (saved.path !== undefined) lastFile.current = saved.path;
      setStatus(statusOf(session.snapshot()));
      busyRef.current = false;
      turn.current = undefined;
      setBusy(false);
      if (exitRequested.current) finish();
    }
  };

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      finish();
      return;
    }
    if (busy) return;
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape) {
      const clean = value.replace(/[\r\n]/g, "");
      if (clean !== "") setInput((current) => current + clean);
    }
  });

  const place = branch === undefined ? cwd : `${cwd} (${branch})`;
  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry, index) => <EntryLine key={index} entry={entry} />}
      </Static>
      {busy ? <Text color="yellow">pensando…</Text> : null}
      <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan">{"> "}</Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>
        {place} · {status.model} · {status.turns} turno(s) · {status.tokensIn}/{status.tokensOut} tokens · {money(status.costUsd)}
      </Text>
    </Box>
  );
}
