/** Comandos de barra do REPL do chat (T1): parser puro, sem I/O. */
export type ReplCommand =
  | { kind: "prompt"; text: string }
  | { kind: "empty" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "model"; model?: string }
  | { kind: "providers" }
  | { kind: "provider"; provider?: string }
  | { kind: "session" }
  | { kind: "details" }
  | { kind: "save" }
  | { kind: "sessions" }
  | { kind: "resume"; ref?: string }
  | { kind: "export"; path?: string }
  | { kind: "init" }
  | { kind: "unknown"; raw: string };

export const HELP_TEXT = [
  "Comandos:",
  "  /help           esta ajuda",
  "  /model [alvo]   lista modelos ou troca (provider/id)",
  "  /providers      lista providers (kind, credencial, quota, modelos)",
  "  /provider [nome]  lista ou troca de provider",
  "  /session        id, início, modelo, turnos, tokens, custo e arquivo",
  "  /details        id, provider, modelo, uptime, turnos, tokens, custo e origem",
  "  /sessions       lista sessões gravadas (mais recentes primeiro)",
  "  /resume <n|id>  retoma uma sessão da lista ou pelo id",
  "  /save           grava a sessão sanitizada e mostra o caminho",
  "  /export [arquivo]  exporta a conversa em Markdown (default .astro/exports/)",
  "  /init           cria AGENTS.md no cwd se ainda não existir",
  "  /clear | /new   limpa o histórico (mantém o system)",
  "  /exit | /quit | /q  encerra a sessão",
].join("\n");

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
      return { kind: "provider", ...(arg === "" ? {} : { provider: arg }) };
    case "session":
      return { kind: "session" };
    case "details":
      return { kind: "details" };
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
