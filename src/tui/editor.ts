/** Completions do editor da TUI: `/` comandos e `@` arquivos (puro). */
import { searchFiles } from "./files";

export interface CommandInfo {
  readonly name: string;
  readonly description: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "/help", description: "mostra esta ajuda" },
  { name: "/model", description: "lista ou troca o modelo" },
  { name: "/providers", description: "lista os providers configurados" },
  { name: "/provider", description: "gerencia perfis (add/edit/remove/use)" },
  { name: "/session", description: "resumo da sessão atual" },
  { name: "/details", description: "detalhes: provider, uptime, tokens, custo" },
  { name: "/sessions", description: "lista as sessões gravadas" },
  { name: "/resume", description: "retoma uma sessão gravada" },
  { name: "/save", description: "grava a sessão em disco" },
  { name: "/export", description: "exporta a conversa em Markdown" },
  { name: "/init", description: "cria AGENTS.md no diretório atual" },
  { name: "/compact", description: "resume o histórico em um sumário" },
  { name: "/summarize", description: "alias de /compact" },
  { name: "/new", description: "limpa o histórico (alias de /clear)" },
  { name: "/clear", description: "limpa o histórico" },
  { name: "/exit", description: "encerra a sessão" },
];

/** Itens que o painel deve mostrar para a linha atual (sem corte fixo). */
export function completionItems(
  line: string,
  commands: readonly CommandInfo[] = COMMANDS,
  files: readonly string[] = [],
): string[] {
  if (line.startsWith("/") && !line.includes(" ")) {
    return commands.filter((command) => command.name.startsWith(line)).map((command) => command.name);
  }
  const at = line.lastIndexOf("@");
  if (at >= 0 && (at === 0 || /\s/.test(line[at - 1]!))) {
    const query = line.slice(at + 1);
    if (!/\s/.test(query)) return searchFiles(files, query).map((file) => `@${file}`);
  }
  return [];
}

/** Descrição de um comando para o painel de sugestões. */
export function commandDescription(name: string, commands: readonly CommandInfo[] = COMMANDS): string | undefined {
  return commands.find((command) => command.name === name)?.description;
}

export const MAX_VISIBLE_SUGGESTIONS = 8;

/** Janela de rolagem [start, end) que mantém `selected` visível. */
export function suggestionWindow(length: number, selected: number, max = MAX_VISIBLE_SUGGESTIONS): { start: number; end: number } {
  const count = Math.min(length, max);
  if (length <= max) return { start: 0, end: count };
  const start = Math.max(0, Math.min(selected - Math.floor(max / 2), length - max));
  return { start, end: start + count };
}

/** Aplica a escolha à linha: comando substitui tudo; arquivo mantém o texto anterior. */
export function applyCompletion(line: string, choice: string): string {
  if (line.startsWith("/")) return choice;
  const at = line.lastIndexOf("@");
  if (at < 0) return line;
  return `${line.slice(0, at)}${choice} `;
}
