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
import type { ShellRunner } from "./shell";
import { COMMANDS, applyCompletion, completionItems } from "./editor";
import { indexFiles } from "./files";
import { Markdown } from "./markdown";
import { loadTuiConfig, saveTuiConfig, getThemeColors, type Theme, type ThemeColors } from "./theme";
import { LEADER, runKeybind } from "./keybinds";
import { ProviderScreen } from "./provider-screen";
import type { ProfileManager } from "../provider/profile-manager";

export interface TuiAppProps {
  session: ChatSession;
  cwd: string;
  branch?: string;
  store?: SessionStore;
  approvals?: ApprovalBridge;
  shell?: ShellRunner;
  manager?: ProfileManager;
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

function EntryLine({ entry, colors }: { entry: Entry; colors: ThemeColors }): ReactElement {
  if (entry.kind === "user") return <Text color={colors.accent}>{"> "}{entry.text}</Text>;
  if (entry.kind === "assistant") return <Markdown text={entry.text} />;
  if (entry.kind === "error") return <Text color={colors.error}>{entry.text}</Text>;
  return <Text dimColor>{entry.text}</Text>;
}

/** Persiste o último modelo sem derrubar a ativação se o arquivo falhar. */
export function persistLastModel(cwd: string, model: string, onWarning?: (message: string) => void): void {
  try {
    saveTuiConfig(cwd, { lastModel: model });
  } catch {
    const message = "aviso: não foi possível salvar o último modelo da TUI";
    if (onWarning === undefined) console.error(message);
    else onWarning(message);
  }
}

/** Ativa o provider na sessão e persiste o último modelo, sem falhar a ativação. */
export function activateProvider(
  session: Pick<ChatSession, "reload" | "setProvider" | "snapshot">,
  cwd: string,
  id: string,
  onWarning?: (message: string) => void,
): void {
  session.reload?.();
  session.setProvider(id);
  persistLastModel(cwd, session.snapshot().model, onWarning);
}

export function TuiApp({ session, cwd, branch, store, approvals, shell, manager, onExit }: TuiAppProps): ReactElement {
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
  const [partial, setPartial] = useState<string | undefined>(undefined);
  const [theme, setTheme] = useState<Theme>(() => loadTuiConfig(cwd).theme);
  const colors = getThemeColors(theme);
  const persistTheme = (next: Theme): void => {
    setTheme(next);
    saveTuiConfig(cwd, { theme: next });
  };
  const leader = useRef(false);
  const busyRef = useRef(false);
  const turn = useRef<AbortController | undefined>(undefined);
  const exitRequested = useRef(false);
  const [status, setStatus] = useState<Status>(() => statusOf(session.snapshot()));
  const [screen, setScreen] = useState<{ mode: "list" | "add" | "edit" | "remove"; target?: string } | undefined>(undefined);
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
    if (text.startsWith("!")) {
      setEntries((current) => [...current, { kind: "user", text }]);
      if (shell === undefined) {
        setEntries((current) => [...current, { kind: "error", text: "shell indisponível" }]);
        return;
      }
      busyRef.current = true;
      const shellTurn = new AbortController();
      turn.current = shellTurn;
      setBusy(true);
      try {
        const result = await shell.run(text.slice(1), shellTurn.signal);
        setEntries((current) => [
          ...current,
          { kind: result.isError ? "error" : "info", text: result.output },
        ]);
      } finally {
        busyRef.current = false;
        turn.current = undefined;
        setBusy(false);
        if (exitRequested.current) finish();
      }
      return;
    }
    const command = parseCommand(text);
    if (command.kind === "empty") return;
    if (command.kind === "exit") {
      finish();
      return;
    }
    if (command.kind !== "prompt") {
      const outcome = await runCommand(command, session, commandState.current, store, cwd);
      if (outcome.openProviders !== undefined) {
        if (manager === undefined) {
          setEntries((current) => [...current, { kind: "error", text: "tela de providers indisponível" }]);
          return;
        }
        setEntries((current) => [...current, ...outcome.entries]);
        setScreen(outcome.openProviders);
        return;
      }
      if (outcome.lastFile !== undefined) commandState.current.lastFile = outcome.lastFile ?? undefined;
      const added = [...outcome.entries];
      const modelChanged = (command.kind === "model" && command.model !== undefined)
        || (command.kind === "provider" && command.action === "use" && command.target !== undefined)
        || (command.kind === "resume" && command.ref !== undefined && !outcome.entries.some((entry) => entry.kind === "error"));
      if (modelChanged) {
        try {
          saveTuiConfig(cwd, { lastModel: session.snapshot().model });
        } catch (error) {
          added.push({ kind: "error", text: `erro: ${messageOf(error)}` });
        }
      }
      setEntries((current) => [...current, ...added]);
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
      let streamed = "";
      const result = await session.send(command.text, controller.signal, (delta) => {
        streamed += delta;
        setPartial(streamed);
      });
      setPartial(undefined);
      setEntries((current) => [
        ...current,
        { kind: "assistant", text: result.final },
        { kind: "info", text: statusLine(result) },
      ]);
    } catch (error) {
      setEntries((current) => [...current, { kind: "error", text: `erro: ${messageOf(error)}` }]);
      if (isFatalSessionError(error)) exitRequested.current = true;
    } finally {
      setPartial(undefined);
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

  useInput((value, key) => {    if (screen !== undefined) return; const ctrl = key.ctrl === true;
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
    if (busy || busyRef.current) return;
    if (leader.current) {
      leader.current = false;
      runKeybind(`${LEADER} ${value.toLowerCase()}`, {
        session,
        ...(store === undefined ? {} : { store }),
        theme,
        addEntries: (added) => setEntries((current) => [...current, ...added]),
        setTheme: persistTheme,
        finish,
      });
      return;
    }
    if (ctrl && value === "x") {
      leader.current = true;
      return;
    }
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

  if (screen !== undefined && manager !== undefined) {
    return (
      <ProviderScreen
        manager={manager}
        colors={colors}
        currentModel={session.model}
        initial={screen}
        onClose={() => setScreen(undefined)}
        onActivate={(id) => {
          activateProvider(session, cwd, id, (text) => {
            setEntries((current) => [...current, { kind: "error", text }]);
          });
          setStatus(statusOf(session.snapshot()));
          setEntries((current) => [...current, { kind: "info", text: `provider: ${session.model}` }]);
        }}
        onChanged={() => {
          try {
            session.reload?.();
            setStatus(statusOf(session.snapshot()));
          } catch (error) {
            setEntries((current) => [...current, { kind: "error", text: `erro: ${messageOf(error)}` }]);
          }
        }}
      />
    );
  }

  const place = branch === undefined ? cwd : `${cwd} (${branch})`;
  const suggestions = question === undefined ? completionItems(input, COMMANDS, files) : [];
  const selectedIndex = suggestions.length === 0 ? 0 : Math.min(selected, suggestions.length - 1);
  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry, index) => <EntryLine key={index} entry={entry} colors={colors} />}
      </Static>
      {busy ? <Text color={colors.warning}>pensando…</Text> : null}
      {partial === undefined ? null : <Text>{partial}</Text>}
      {question === undefined ? null : <Text color={colors.warning}>{question}</Text>}
      <Box marginTop={1} borderStyle="round" borderColor={colors.accent} paddingX={1}>
        <Text color={colors.accent}>{"> "}</Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
      {suggestions.map((item, index) => (
        <Text key={item} {...(index === selectedIndex ? { color: colors.accent } : { dimColor: true })}>
          {index === selectedIndex ? "> " : "  "}{item}
        </Text>
      ))}
      <Text dimColor>
        {place} · {status.model} · {status.turns} turno(s) · {status.tokensIn}/{status.tokensOut} tokens · {money(status.costUsd)}
      </Text>
    </Box>
  );
}
