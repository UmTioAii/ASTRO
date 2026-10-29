/** Completions do editor da TUI: `/` comandos e `@` arquivos (puro). */
import { searchFiles } from "./files";

export const COMMANDS = [
  "/help", "/model", "/providers", "/provider", "/session", "/details", "/sessions", "/resume",
  "/save", "/export", "/init", "/compact", "/summarize", "/new", "/clear", "/exit",
] as const;

/** Itens que o painel deve mostrar para a linha atual. */
export function completionItems(
  line: string,
  commands: readonly string[] = COMMANDS,
  files: readonly string[] = [],
): string[] {
  if (line.startsWith("/") && !line.includes(" ")) {
    return commands.filter((command) => command.startsWith(line)).slice(0, 6);
  }
  const at = line.lastIndexOf("@");
  if (at >= 0 && (at === 0 || /\s/.test(line[at - 1]!))) {
    const query = line.slice(at + 1);
    if (!/\s/.test(query)) return searchFiles(files, query).map((file) => `@${file}`);
  }
  return [];
}

/** Aplica a escolha à linha: comando substitui tudo; arquivo mantém o texto anterior. */
export function applyCompletion(line: string, choice: string): string {
  if (line.startsWith("/")) return choice;
  const at = line.lastIndexOf("@");
  if (at < 0) return line;
  return `${line.slice(0, at)}${choice} `;
}
