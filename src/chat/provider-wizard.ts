/** Wizard linear de `/provider add|edit`: prompts no REPL, sem tocar segredo. */
import { PROVIDER_CATALOG, type CatalogEntry } from "../provider/catalog";
import type { ProfileDraft, ProfileManager, ProfileView } from "../provider/profile-manager";
import type { ProfileModel, ProviderProfile } from "../provider/profiles";

export interface WizardIO {
  read(prompt: string): Promise<string | null>;
  write(text: string): void;
}

export interface WizardOptions {
  mode: "add" | "edit";
  profile?: ProviderProfile;
  /** Nome inicial vindo de `/provider add <nome>`. */
  initialName?: string;
  onUse?: (id: string) => void;
}

const DEFAULT_CONTEXT = 128_000;

/** Mesmo padrão de `ENV_NAME` em src/provider/profiles.ts: nome de variável de ambiente. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ask(io: WizardIO, label: string, fallback: string): Promise<string | undefined> {
  const suffix = fallback === "" ? "" : ` [${fallback}]`;
  const answer = await io.read(`${label}${suffix}: `);
  if (answer === null) return undefined;
  const trimmed = answer.trim();
  return trimmed === "" ? fallback : trimmed;
}

function modelsFrom(ids: string, known: readonly ProfileModel[]): ProfileModel[] {
  return ids
    .split(/[;,]/)
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .map((id) => {
      const existing = known.find((model) => model.id === id);
      return existing === undefined
        ? { id, tags: [], context: DEFAULT_CONTEXT }
        : { id: existing.id, tags: [...existing.tags], context: existing.context };
    });
}

function catalogFor(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}

export async function runProviderWizard(
  io: WizardIO,
  manager: ProfileManager,
  opts: WizardOptions,
): Promise<ProfileView | undefined> {
  const current = opts.profile;
  let entry: CatalogEntry | undefined;

  if (opts.mode === "add") {
    const keys = PROVIDER_CATALOG.map((item) => item.key).join("/");
    const choice = await ask(io, `catálogo [${keys}/custom]`, "custom");
    if (choice === undefined) return undefined;
    if (choice !== "custom") {
      entry = catalogFor(choice);
      if (entry === undefined) {
        io.write(`catálogo desconhecido: "${choice}"`);
        return undefined;
      }
    }
  }

  const name = await ask(io, "nome", current?.name ?? opts.initialName ?? entry?.name ?? "");
  if (name === undefined || name === "") {
    io.write("cancelado");
    return undefined;
  }
  const kind = current?.kind ?? entry?.kind ?? "openai-compat";
  const knownModels = [...(current?.models ?? []), ...(entry?.models ?? [])];

  let baseUrl: string | undefined;
  let credentialRef: string | undefined;
  let credentialsPath: string | undefined;

  if (kind === "codex-oauth") {
    credentialsPath = await ask(
      io,
      "credenciais (arquivo)",
      current?.credentialsPath ?? entry?.credentialsPath ?? "~/.codex/auth.json",
    );
    if (credentialsPath === undefined) return undefined;
  } else {
    baseUrl = await ask(io, "base url", current?.baseUrl ?? entry?.baseUrl ?? "");
    if (baseUrl === undefined) return undefined;
    if (baseUrl === "") {
      io.write("base url é obrigatória");
      return undefined;
    }
    for (;;) {
      credentialRef = await ask(
        io,
        "variável da chave (vazio = sem chave)",
        current?.credentialRef ?? entry?.credentialRef ?? "",
      );
      if (credentialRef === undefined) return undefined;
      if (credentialRef === "") {
        credentialRef = undefined;
        break;
      }
      if (ENV_NAME.test(credentialRef)) break;
      io.write(`nome de variável inválido: "${credentialRef}" (maiúsculas, números e _, começando com letra ou _)`);
    }
  }

  const modelsAnswer = await ask(
    io,
    "modelos (separe com ;)",
    (current?.models ?? entry?.models ?? []).map((model) => model.id).join(";"),
  );
  if (modelsAnswer === undefined) return undefined;
  const models = modelsFrom(modelsAnswer, knownModels);
  if (models.length === 0) {
    io.write("informe ao menos um modelo");
    return undefined;
  }

  const quotaDomain = current?.quotaDomain ?? entry?.quotaDomain ?? entry?.key;
  const draft: ProfileDraft = {
    name,
    kind,
    models,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    ...(quotaDomain === undefined ? {} : { quotaDomain }),
    ...(current?.headers === undefined ? {} : { headers: current.headers }),
  };

  io.write([
    `${opts.mode === "edit" ? "editar" : "novo"} provider: ${draft.name}`,
    `  kind:    ${draft.kind}`,
    ...(draft.baseUrl === undefined ? [] : [`  baseUrl: ${draft.baseUrl}`]),
    ...(draft.credentialsPath === undefined ? [] : [`  arquivo: ${draft.credentialsPath}`]),
    `  modelos: ${draft.models.map((model) => model.id).join(", ")}`,
    ...(draft.credentialRef === undefined ? [] : [`  chave:   ${draft.credentialRef}`]),
  ].join("\n"));
  const confirm = await ask(io, "salvar? [S/n]", "S");
  if (confirm === undefined || confirm.toLowerCase().startsWith("n")) {
    io.write("cancelado");
    return undefined;
  }

  let saved: ProfileView;
  try {
    saved = opts.mode === "edit"
      ? manager.edit(current?.id ?? draft.name, draft)
      : manager.add(draft);
  } catch (error) {
    io.write(`erro: ${messageOf(error)}`);
    return undefined;
  }

  if (draft.credentialRef !== undefined && !manager.credentialPresent(draft.credentialRef)) {
    io.write(`! ${draft.credentialRef} não encontrada no ambiente; exporte antes de usar`);
  }

  if (opts.mode === "add") {
    const activate = await ask(io, "ativar agora? [S/n]", "S");
    if (activate !== undefined && !activate.toLowerCase().startsWith("n")) {
      try {
        manager.use(saved.id);
        opts.onUse?.(saved.id);
        io.write(`provider ativo: ${saved.id}`);
      } catch (error) {
        io.write(`erro: ${messageOf(error)}`);
      }
    }
  }

  io.write(`salvo: ${saved.id}`);
  return saved;
}
