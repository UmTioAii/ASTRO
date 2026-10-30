/** Tela cheia de providers (TUI): lista + formulário, sem tocar segredo. */
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { PROVIDER_CATALOG } from "../provider/catalog";
import type { ProfileDraft, ProfileManager, ProfileView } from "../provider/profile-manager";
import type { ProfileModel } from "../provider/profiles";
import type { HealthCheck } from "../health";
import type { CodexLoginStart } from "../provider/codex-login";
import { redactSecrets } from "../sanitize-external";
import { formatProviderCheck } from "./health";
import type { ThemeColors } from "./theme";

export interface ProviderScreenProps {
  manager: ProfileManager;
  colors: ThemeColors;
  /** Modelo `provider/id` em uso pela sessão, para diferenciar do ativo salvo. */
  currentModel?: string;
  initial?: { mode: "list" | "add" | "edit" | "remove"; target?: string };
  onClose: () => void;
  onActivate: (id: string) => void;
  onChanged?: () => void;
  /** Teste real mínimo do provider (C6); ausente desabilita `t`. */
  onTest?: (id: string) => Promise<HealthCheck>;
  /** Login device flow do Codex; ausente desabilita `l`. */
  onLogin?: (id: string, signal?: AbortSignal) => Promise<CodexLoginStart>;
}

type Step = "catalog" | "name" | "baseUrl" | "models" | "credential" | "confirm";

const STEPS: Step[] = ["catalog", "name", "baseUrl", "models", "credential", "confirm"];
const CATALOG = ["custom", ...PROVIDER_CATALOG.map((entry) => entry.key)];
const DEFAULT_CONTEXT = 128_000;

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function parseModels(text: string, known: readonly ProfileModel[]): ProfileModel[] {
  return text
    .split(/[;,]/)
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .map((id) => {
      const found = known.find((model) => model.id === id);
      return found === undefined ? { id, tags: [], context: DEFAULT_CONTEXT } : found;
    });
}

export function ProviderScreen({
  manager, colors, currentModel, initial, onClose, onActivate, onChanged, onTest, onLogin,
}: ProviderScreenProps): ReactElement {
  const initialList = manager.list();
  const initialTarget = initial?.target === undefined
    ? undefined
    : initialList.find((item) => item.id === initial.target)
      ?? initialList.find((item) => item.name.toLowerCase() === initial.target!.toLowerCase());
  const initialEdit = initial?.mode === "edit" && initialTarget?.source === "global" ? initialTarget : undefined;
  const initialRemove = initial?.mode === "remove" && initialTarget?.source === "global" ? initialTarget : undefined;
  const [view, setView] = useState<"list" | "form" | "remove">(
    initial?.mode === "add"
      ? "form"
      : initial?.mode === "edit"
        ? initialEdit === undefined ? "list" : "form"
        : initial?.mode === "remove"
          ? initialRemove === undefined ? "list" : "remove"
          : "list",
  );
  const [selected, setSelected] = useState(() => {
    if (initialTarget === undefined) return 0;
    const index = initialList.findIndex((item) => item.id === initialTarget.id);
    return index < 0 ? 0 : index;
  });
  const [editing, setEditing] = useState<ProfileView | undefined>(initialEdit);
  const [step, setStep] = useState<Step>(initial?.mode === "edit" ? "name" : "catalog");
  const [catalogIndex, setCatalogIndex] = useState(0);
  const [name, setName] = useState(
    initialEdit?.name ?? (initial?.mode === "add" && initial.target !== undefined ? initial.target : ""),
  );
  const [baseUrl, setBaseUrl] = useState(initialEdit?.baseUrl ?? "");
  const [models, setModels] = useState(initialEdit?.models.map((model) => model.id).join(";") ?? "");
  const [credential, setCredential] = useState(initialEdit?.credentialRef ?? "");
  const [message, setMessage] = useState<string | undefined>(() => {
    if (initial?.target === undefined) return undefined;
    if (initialTarget === undefined) return `provider "${initial.target}" não encontrado`;
    if (initial?.mode === "edit" && initialEdit === undefined) {
      return `provider "${initial.target}" é ${initialTarget.source}; edite pelo astro chat`;
    }
    if (initial?.mode === "remove" && initialRemove === undefined) {
      return `provider "${initial.target}" é ${initialTarget.source}; não removível aqui`;
    }
    return undefined;
  });
  const [testTarget, setTestTarget] = useState<ProfileView | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [messageOk, setMessageOk] = useState(false);
  const [login, setLogin] = useState<{ target: ProfileView; url: string; userCode: string } | undefined>(undefined);
  const [loginTarget, setLoginTarget] = useState<ProfileView | undefined>(undefined);
  const [loginStarting, setLoginStarting] = useState(false);
  const probeToken = useRef(0);
  const loginAbort = useRef<AbortController | undefined>(undefined);
  const loginBusy = useRef(false);

  useEffect(() => () => { loginAbort.current?.abort(); }, []);


  const list = manager.list();
  const current = list[Math.min(selected, Math.max(list.length - 1, 0))];
  const entry = catalogIndex === 0 ? undefined : PROVIDER_CATALOG[catalogIndex - 1];
  const kind = editing?.kind ?? entry?.kind ?? "openai-compat";

  const startAdd = (): void => {
    setEditing(undefined);
    setStep("catalog");
    setCatalogIndex(0);
    setName("");
    setBaseUrl("");
    setModels("");
    setCredential("");
    setMessage(undefined);
    setView("form");
  };

  const startEdit = (profile: ProfileView): void => {
    if (profile.source !== "global") {
      setMessage(profile.source === "project"
        ? `provider "${profile.id}" está definido no astro.config.json`
        : `provider "${profile.id}" é efêmero (env)`);
      return;
    }
    setEditing(profile);
    setStep("name");
    setName(profile.name);
    setBaseUrl(profile.baseUrl ?? "");
    setModels(profile.models.map((model) => model.id).join(";"));
    setCredential(profile.credentialRef ?? "");
    setMessage(undefined);
    setView("form");
  };

  const save = (): void => {
    const known = [...(editing?.models ?? []), ...(entry?.models ?? [])];
    const parsedModels = parseModels(models, known);
    if (parsedModels.length === 0) {
      setMessage("informe ao menos um modelo");
      return;
    }
    const draft: ProfileDraft = {
      name,
      kind: editing?.kind ?? entry?.kind ?? "openai-compat",
      models: parsedModels,
      ...(baseUrl === "" ? {} : { baseUrl }),
      ...(credential === "" ? {} : { credentialRef: credential }),
      ...(editing?.credentialsPath === undefined && entry?.credentialsPath === undefined
        ? {}
        : { credentialsPath: editing?.credentialsPath ?? entry?.credentialsPath }),
      ...(editing?.quotaDomain === undefined && entry === undefined
        ? {}
        : { quotaDomain: editing?.quotaDomain ?? entry?.quotaDomain ?? entry?.key }),
      ...(editing?.headers === undefined ? {} : { headers: editing.headers }),
    };
    try {
      const saved = editing === undefined ? manager.add(draft) : manager.edit(editing.id, draft);
      let activationError: string | undefined;
      if (editing === undefined) {
        try {
          manager.use(saved.id);
        } catch (error) {
          activationError = messageOf(error);
        }
      }
      onChanged?.();
      if (editing === undefined && activationError === undefined) {
        try {
          onActivate(saved.id);
        } catch (error) {
          activationError = messageOf(error);
        }
      }
      setView("list");
      setMessage(activationError === undefined ? `salvo: ${saved.id}` : `salvo: ${saved.id} (não ativado: ${activationError})`);
    } catch (error) {
      setMessage(messageOf(error));
    }
  };

  const startLogin = (profile: ProfileView): void => {
    if (onLogin === undefined || loginBusy.current) return;
    loginBusy.current = true;
    setLoginStarting(true);
    const controller = new AbortController();
    loginAbort.current = controller;
    setMessage(undefined);
    void onLogin(profile.id, controller.signal)
      .then((start) => {
        if (controller.signal.aborted) {
          void start.done.catch(() => undefined);
          return undefined;
        }
        setLoginStarting(false);
        setLogin({ target: profile, url: start.device.verificationUrl, userCode: start.device.userCode });
        return start.done;
      })
      .then(() => {
        if (controller.signal.aborted) return;
        try {
          if (profile.source === "global") manager.use(profile.id);
        } catch { /* ativação da sessão abaixo cobre o perfil */ }
        setLogin(undefined);
        setMessageOk(true);
        setMessage(`${profile.id}: login concluído`);
        onChanged?.();
        onActivate(profile.id);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLogin(undefined);
        setMessageOk(false);
        setMessage(`erro: ${messageOf(error)}`);
      })
      .finally(() => {
        loginBusy.current = false;
        setLoginStarting(false);
      });
  };

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) {
      loginAbort.current?.abort();
      onClose();
      return;
    }
    if (loginTarget !== undefined) {
      if (key.escape) {
        setLoginTarget(undefined);
        setMessage(undefined);
        return;
      }
      if (key.return) {
        const target = loginTarget;
        setLoginTarget(undefined);
        startLogin(target);
      }
      return;
    }
    if (loginStarting) {
      if (key.escape) {
        loginAbort.current?.abort();
        setLoginStarting(false);
        setMessageOk(false);
        setMessage("login cancelado");
      }
      return;
    }
    if (login !== undefined) {
      if (key.escape) {
        loginAbort.current?.abort();
        loginAbort.current = undefined;
        setLogin(undefined);
        setMessageOk(false);
        setMessage("login cancelado");
      }
      return;
    }
    if (testTarget !== undefined) {
      if (key.escape) {
        probeToken.current++;
        setTestTarget(undefined);
        setTesting(false);
        setMessage(undefined);
        return;
      }
      if (key.return && !testing) {
        const token = ++probeToken.current;
        const target = testTarget;
        setTesting(true);
        setMessage(undefined);
        void onTest?.(target.id)
          .then((check) => {
            if (token !== probeToken.current) return;
            setMessage(`${target.id}: ${formatProviderCheck(check)}`);
            setMessageOk(check.status === "ok");
          })
          .catch((error) => {
            if (token !== probeToken.current) return;
            setMessage(`erro: ${messageOf(error)}`);
            setMessageOk(false);
          })
          .finally(() => {
            if (token !== probeToken.current) return;
            setTesting(false);
            setTestTarget(undefined);
          });
      }
      return;
    }
    if (view === "list") {
      if (key.escape) { onClose(); return; }
      if (key.upArrow) { setSelected((value) => Math.max(0, value - 1)); setMessage(undefined); return; }
      if (key.downArrow) { setSelected((value) => Math.min(list.length - 1, value + 1)); setMessage(undefined); return; }
      if (input === "a") { startAdd(); return; }
      if (input === "t") {
        if (onTest !== undefined && current !== undefined) {
          setMessage(undefined);
          setTestTarget(current);
        }
        return;
      }
      if (input === "l") {
        if (onLogin !== undefined && current !== undefined && current.kind === "codex-oauth") {
          setMessage(undefined);
          setLoginTarget(current);
        }
        return;
      }
      if (input === "e") { if (current !== undefined) startEdit(current); return; }
      if (input === "d") {
        if (current === undefined) return;
        if (current.source !== "global") {
          setMessage(current.source === "project"
            ? `provider "${current.id}" está definido no astro.config.json`
            : `provider "${current.id}" é efêmero (env)`);
          return;
        }
        setView("remove");
        return;
      }
      if (key.return && current !== undefined) {
        try {
          if (current.source === "global") manager.use(current.id);
          onActivate(current.id);
          setMessage(`ativo: ${current.id}`);
          onChanged?.();
        } catch (error) {
          setMessage(messageOf(error));
        }
      }
      return;
    }

    if (view === "remove") {
      if (input === "s" && current !== undefined) {
        try {
          manager.remove(current.id);
          onChanged?.();
              setMessage(`removido: ${current.id}`);
        } catch (error) {
          setMessage(messageOf(error));
        }
        setView("list");
        return;
      }
      if (input === "n" || key.escape) setView("list");
      return;
    }

    if (key.escape) {
      const index = STEPS.indexOf(step);
      if (index <= 0) { setView("list"); return; }
      setStep(STEPS[index - 1] as Step);
      return;
    }

    if (step === "catalog") {
      if (key.upArrow) { setCatalogIndex((value) => Math.max(0, value - 1)); return; }
      if (key.downArrow) { setCatalogIndex((value) => Math.min(CATALOG.length - 1, value + 1)); return; }
      if (key.return) {
        const chosen = catalogIndex === 0 ? undefined : PROVIDER_CATALOG[catalogIndex - 1];
        if (chosen !== undefined) {
          setName(chosen.name);
          setBaseUrl(chosen.baseUrl ?? "");
          setModels(chosen.models.map((model) => model.id).join(";"));
          setCredential(chosen.credentialRef ?? "");
        }
        setStep("name");
      }
      return;
    }

    if (key.return) {
      const index = STEPS.indexOf(step);
      if (step === "baseUrl" && baseUrl.trim() === "" && kind !== "codex-oauth") {
        setMessage("base url é obrigatória");
        return;
      }
      if (step === "credential" && credential.trim() !== "" && kind !== "codex-oauth") {
        const valid = /^[A-Z_][A-Z0-9_]*$/.test(credential.trim());
        if (!valid) { setMessage("use o nome da variável, ex.: OPENAI_API_KEY"); return; }
      }
      setMessage(undefined);
      setStep(STEPS[index + 1] ?? "confirm");
      if (step === "confirm") save();
      return;
    }
    if (key.backspace || key.delete) {
      if (step === "name") setName((value) => value.slice(0, -1));
      else if (step === "baseUrl") setBaseUrl((value) => value.slice(0, -1));
      else if (step === "models") setModels((value) => value.slice(0, -1));
      else if (step === "credential") setCredential((value) => value.slice(0, -1));
      return;
    }
    if (input === "") return;
    if (step === "name") setName((value) => value + input);
    else if (step === "baseUrl") setBaseUrl((value) => value + input);
    else if (step === "models") setModels((value) => value + input);
    else if (step === "credential") setCredential((value) => value + input);
  });

  if (loginTarget !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Login Codex: {loginTarget.name}</Text>
        <Text>grava em {loginTarget.credentialsPath ?? "~/.codex/auth.json"}</Text>
        <Text dimColor>enter confirmar · esc cancelar</Text>
      </Box>
    );
  }

  if (loginStarting) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Login Codex: iniciando…</Text>
        <Text dimColor>esc cancela</Text>
      </Box>
    );
  }

  if (login !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Login Codex: {login.target.name}</Text>
        <Text>abra {login.url} e informe o código {login.userCode}</Text>
        <Text dimColor>aguardando… esc cancela</Text>
        {message === undefined ? null : <Text color={messageOk ? colors.accent : colors.error}>{message}</Text>}
      </Box>
    );
  }

  if (testTarget !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Testar {testTarget.name}?</Text>
        <Text dimColor>{testing ? "testando…" : "enter confirmar · esc cancelar"}</Text>
        {message === undefined ? null : <Text color={messageOk ? colors.accent : colors.error}>{message}</Text>}
      </Box>
    );
  }

  if (view === "remove" && current !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colors.warning}>Remover {current.name}?</Text>
        <Text dimColor>s remover · n cancelar</Text>
        {message === undefined ? null : <Text color={colors.error}>{message}</Text>}
      </Box>
    );
  }

  if (view === "form") {
    const labels: Record<Step, string> = {
      catalog: "De onde partir?",
      name: "Nome",
      baseUrl: "Base URL",
      models: "Modelos (separe com ;)",
      credential: "Variável da chave (vazio = sem chave)",
      confirm: "Confirmar",
    };
    const value = step === "name" ? name
      : step === "baseUrl" ? baseUrl
        : step === "models" ? models
          : step === "credential" ? credential
            : "";
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{editing === undefined ? "Novo provider" : `Editar ${editing.id}`}</Text>
        <Text>{labels[step]}</Text>
        {step === "catalog"
          ? CATALOG.map((item, index) => (
              <Text key={item} color={index === catalogIndex ? colors.accent : undefined}>
                {index === catalogIndex ? "> " : "  "}{item}
              </Text>
            ))
          : step === "confirm"
            ? (
                <Box flexDirection="column">
                  <Text>nome:    {name}</Text>
                  <Text>baseUrl: {baseUrl || "-"}</Text>
                  <Text>modelos: {models}</Text>
                  <Text>chave:   {credential || "-"}</Text>
                  <Text dimColor>enter salvar · esc voltar</Text>
                </Box>
              )
            : <Text color={colors.accent}>{step === "credential" ? "*".repeat(value.length) || " " : value || " "}</Text>}
        <Text dimColor>
          {step === "catalog" ? "↑↓ escolher · enter continuar · esc voltar" : `${STEPS.indexOf(step) + 1}/6 · enter continuar · esc voltar`}
        </Text>
        {message === undefined ? null : <Text color={colors.error}>{message}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Providers</Text>
      {currentModel === undefined ? null : <Text dimColor>em uso: {currentModel}</Text>}
      {list.length === 0 ? <Text dimColor>nenhum provider</Text> : null}
      {list.map((profile, index) => (
        <Text key={profile.id} color={index === selected ? colors.accent : undefined}>
          {index === selected ? "> " : "  "}
          {profile.source === "env" ? "◐" : profile.active ? "●" : "○"} {profile.name} ({profile.id}){" "}
          {profile.kind} {profile.baseUrl ?? profile.credentialsPath ?? "-"}{" "}
          cred={profile.credentialRef ?? "sem chave"} [{profile.source}]
        </Text>
      ))}
      <Text dimColor>
        {["a adicionar", "e editar", "d remover",
          ...(onTest === undefined ? [] : ["t testar"]),
          ...(onLogin === undefined || current?.kind !== "codex-oauth" ? [] : ["l login"]),
          "enter ativar", "esc voltar"].join(" · ")}
      </Text>
      {message === undefined ? null : <Text color={messageOk ? colors.accent : colors.error}>{message}</Text>}
    </Box>
  );
}
