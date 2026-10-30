/** Comandos de barra do REPL do chat (T1): parser puro, sem I/O. */
export type ProviderAction = "list" | "add" | "edit" | "remove" | "use";

export type ReplCommand =
  | { kind: "prompt"; text: string }
  | { kind: "empty" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "model"; model?: string }
  | { kind: "providers" }
  | { kind: "provider"; action: ProviderAction; target?: string }
  | { kind: "session" }
  | { kind: "details" }
  | { kind: "compact"; force?: boolean }
  | { kind: "save" }
  | { kind: "sessions" }
  | { kind: "resume"; ref?: string }
  | { kind: "export"; path?: string }
  | { kind: "init" }
  | { kind: "unknown"; raw: string };

export const HELP_TEXT = [
  "Comandos:",
  "  /help           esta ajuda",
  "  /model [alvo]   lista (REPL) ou abre o seletor (TUI); com alvo, troca",
  "  /providers      lista providers (kind, credencial, quota, modelos)",
  "  /provider       lista perfis (projeto, globais, env) e o ativo",
  "  /provider add   cria um perfil (catálogo ou custom)",
  "  /provider edit <nome|id>   edita um perfil global",
  "  /provider remove <nome|id> remove um perfil global",
  "  /provider use <nome|id>    ativa um perfil global",
  "  /session        id, início, modelo, turnos, tokens, custo e arquivo",
  "  /details        id, provider, modelo, uptime, turnos, tokens, custo e origem",
  "  /compact        resume o histórico (sem tools) e substitui por sumário",
  "  /compact force  ignora a pausa do breaker e força a compactação",
  "  /summarize      alias de /compact",
  "  /sessions       lista sessões gravadas (mais recentes primeiro)",
  "  /resume <n|id>  retoma uma sessão da lista ou pelo id",
  "  /save           grava a sessão sanitizada e mostra o caminho",
  "  /export [arquivo]  exporta a conversa em Markdown (default .astro/exports/)",
  "  /init           cria AGENTS.md no cwd se ainda não existir",
  "  /clear | /new   limpa o histórico (mantém o system)",
  "  /exit | /quit | /q  encerra a sessão",
].join("\n");

function parseProvider(arg: string): ReplCommand {
  const [sub, ...rest] = arg.split(/\s+/).filter((part) => part !== "");
  if (sub === undefined) return { kind: "provider", action: "list" };
  const target = rest.join(" ").trim();
  switch (sub.toLowerCase()) {
    case "list":
      return { kind: "provider", action: "list" };
    case "add":
      return { kind: "provider", action: "add", ...(target === "" ? {} : { target }) };
    case "edit":
    case "remove":
    case "use":
      if (target === "") return { kind: "provider", action: sub.toLowerCase() as ProviderAction };
      return { kind: "provider", action: sub.toLowerCase() as ProviderAction, target };
    default:
      // Compatibilidade: /provider <nome> equivale a /provider use <nome>.
      return { kind: "provider", action: "use", target: arg.trim() };
  }
}

export function parseCommand(line: string): ReplCommand {
  const text = line.trim();
  if (text === "") return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "prompt", text };
  const [name, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch ((name ?? "").toLowerCase()) {
    case "help":
      return { kind: "help" };
    case "exit":
    case "quit":
    case "q":
      return { kind: "exit" };
    case "clear":
    case "new":
      return { kind: "clear" };
    case "model":
      return { kind: "model", ...(arg === "" ? {} : { model: arg }) };
    case "providers":
      return { kind: "providers" };
    case "provider":
      return parseProvider(arg);
    case "session":
      return { kind: "session" };
    case "details":
      return { kind: "details" };
    case "compact":
    case "summarize":
      return arg.trim().toLowerCase() === "force"
        ? { kind: "compact", force: true }
        : { kind: "compact" };
    case "save":
      return { kind: "save" };
    case "sessions":
      return { kind: "sessions" };
    case "resume":
      return { kind: "resume", ...(arg === "" ? {} : { ref: arg }) };
    case "export":
      return { kind: "export", ...(arg === "" ? {} : { path: arg }) };
    case "init":
      return { kind: "init" };
    default:
      return { kind: "unknown", raw: name ?? "" };
  }
}
