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
  | { kind: "unknown"; raw: string };

export const HELP_TEXT = [
  "Comandos:",
  "  /help           esta ajuda",
  "  /model [alvo]   lista modelos ou troca (provider/id)",
  "  /providers      lista providers (kind, credencial, quota, modelos)",
  "  /provider [nome]  lista ou troca de provider",
  "  /clear          limpa o histórico (mantém o system)",
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
      return { kind: "clear" };
    case "model":
      return { kind: "model", ...(arg === "" ? {} : { model: arg }) };
    case "providers":
      return { kind: "providers" };
    case "provider":
      return { kind: "provider", ...(arg === "" ? {} : { provider: arg }) };
    default:
      return { kind: "unknown", raw: name ?? "" };
  }
}
