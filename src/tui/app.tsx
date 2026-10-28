/** TUI (T2): conversa, entrada e status bar. Consome apenas a ChatSession. */
import { Box, Static, Text, useInput } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { parseCommand } from "../chat/commands";
import { statusLine, type ChatSession } from "../chat/repl";
import type { SessionStore } from "../chat/store";
import type { SessionSnapshot } from "../chat/agent-session";
import { isFatalSessionError } from "../chat/session-errors";
import { redactSecrets } from "../sanitize-external";
import { runCommand, type CommandState, type Entry } from "./commands";
import type { ApprovalBridge } from "./approvals";
import { COMMANDS, applyCompletion, completionItems } from "./editor";
import { indexFiles } from "./files";

export interface TuiAppProps {
  session: ChatSession;
  cwd: string;
  branch?: string;
  store?: SessionStore;
  approvals?: ApprovalBridge;
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

export function TuiApp({ session, cwd, branch, store, approvals, onExit }: TuiAppProps): ReactElement {
  const [entries, setEntries] = useState<Entry[]>([{ kind: "info", text: WELCOME }]);
  const [question, setQuestion] = useState<string | undefined>(() => approvals?.current()?.text);
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
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
  const commandState = useRef<CommandState>({});
  const exited = useRef(false);

  useEffect(() => {
    approvals?.subscribe((pendingQuestion) => setQuestion(pendingQuestion?.text));
  }, [approvals]);

  useEffect(() => {
    setFiles(indexFiles(cwd));
  }, [cwd]);

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
      if (exitRequested.current) {
        // segundo pedido: desmonta mesmo sem o provider responder
        exited.current = true;
        persist(false);
        onExit?.();
        return;
      }
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
      const outcome = runCommand(command, session, commandState.current, store, cwd);
      if (outcome.lastFile !== undefined) commandState.current.lastFile = outcome.lastFile ?? undefined;
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
      if (saved.failed) commandState.current.lastFile = undefined;
      else if (saved.path !== undefined) commandState.current.lastFile = saved.path;
      setStatus(statusOf(session.snapshot()));
      busyRef.current = false;
      turn.current = undefined;
      setBusy(false);
      if (exitRequested.current) finish();
    }
  };

  useInput((value, key) => {    const ctrl = key.ctrl === true;
    if (ctrl && (value === "c" || value === "d")) {
      approvals?.answer("");
      finish();
      return;
    }
    if (question !== undefined) {
      if (key.return) {
        const answer = inputRef.current;
        setInput(() => "");
        approvals?.answer(answer);
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
      return;
    }
    if (busy) return;
    if (suggestions.length > 0) {
      if (key.tab) {
        setInput(() => applyCompletion(inputRef.current, suggestions[selectedIndex]!));
        setSelected(0);
        return;
      }
      if (key.upArrow) {
        setSelected((selectedIndex - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelected((selectedIndex + 1) % suggestions.length);
        return;
      }
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape) {
      const clean = value.replace(/[\r\n]/g, "");
      if (clean !== "") {
        const before = inputRef.current;
        setInput((current) => current + clean);
        setSelected(0);
        if (!before.includes("@") && `${before}${clean}`.includes("@")) setFiles(indexFiles(cwd));
      }
    }
  });

  const place = branch === undefined ? cwd : `${cwd} (${branch})`;
  const suggestions = question === undefined ? completionItems(input, COMMANDS, files) : [];
  const selectedIndex = suggestions.length === 0 ? 0 : Math.min(selected, suggestions.length - 1);
  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry, index) => <EntryLine key={index} entry={entry} />}
      </Static>
      {busy ? <Text color="yellow">pensando…</Text> : null}
      {question === undefined ? null : <Text color="yellow">{question}</Text>}
      <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan">{"> "}</Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
      {suggestions.map((item, index) => (
        <Text key={item} {...(index === selectedIndex ? { color: "cyan" } : { dimColor: true })}>
          {index === selectedIndex ? "> " : "  "}{item}
        </Text>
      ))}
      <Text dimColor>
        {place} · {status.model} · {status.turns} turno(s) · {status.tokensIn}/{status.tokensOut} tokens · {money(status.costUsd)}
      </Text>
    </Box>
  );
}
