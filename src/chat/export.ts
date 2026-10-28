/** Exportação da sessão para Markdown, confinada ao cwd (I-11). */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ChatMessage } from "../provider/types";
import type { SessionSnapshot } from "./agent-session";
import { resolveWithin } from "../tools/paths";
import { redactSecrets } from "../sanitize-external";

const SYSTEM = new Set(["system"]);

function roleTitle(role: ChatMessage["role"]): string {
  return role === "user" ? "Usuário" : role === "assistant" ? "Assistente" : "Tool";
}

function toolSummary(call: { name: string; id: string; arguments: string }): string {
  const args = redactSecrets(call.arguments).trim();
  const short = args.length > 200 ? `${args.slice(0, 200)}…` : args;
  return `- \`${call.name}\` (${call.id}): \`${short}\``;
}

/** Markdown da conversa (sem o system prompt) com metadados da sessão. */
export function renderMarkdown(snapshot: SessionSnapshot): string {
  const cost = snapshot.costUsd === null ? "n/d" : `US$ ${snapshot.costUsd.toFixed(6)}`;
  const header = [
    `# Sessão ${snapshot.id}`,
    "",
    `- Início: ${snapshot.startedAt}`,
    `- Modelo: ${snapshot.model}`,
    `- Turnos: ${snapshot.turns}`,
    `- Tokens: ${snapshot.tokensIn} entrada / ${snapshot.tokensOut} saída`,
    `- Custo: ${cost}`,
    ...(snapshot.resumedFrom === undefined
      ? []
      : [`- Retomada de: ${snapshot.resumedFrom.id} (${snapshot.resumedFrom.startedAt})`]),
    "",
  ];
  const body: string[] = [];
  for (const message of snapshot.messages) {
    if (SYSTEM.has(message.role)) continue;
    body.push(`## ${roleTitle(message.role)}`, "", redactSecrets(message.content).trim(), "");
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      body.push("Chamadas de tool:", "");
      for (const call of message.toolCalls) body.push(toolSummary(call));
      body.push("");
    }
  }
  return `${header.join("\n")}\n${body.join("\n")}`.trimEnd() + "\n";
}

/** Caminho dentro do cwd (real, sem symlink/junction) e fora do estado do harness. */
export function exportPath(cwd: string, snapshot: SessionSnapshot, target?: string): string {
  const requested = target ?? join(".astro", "exports", `${snapshot.startedAt.replace(/[:.]/g, "-")}-${snapshot.id}.md`);
  let path: string;
  try {
    path = resolveWithin(cwd, requested);
  } catch {
    throw new Error("caminho de exportação fora do cwd");
  }
  const parts = relative(resolve(cwd), path).split(sep);
  const folding = process.platform === "win32" || process.platform === "darwin";
  // Win32 normaliza pontos/espaços à direita: `.astro.` e `.astro ` são o mesmo diretório.
  const normalize = (value: string | undefined): string | undefined =>
    folding ? value?.toLowerCase().replace(/[ .]+$/, "") : value;
  const same = (value: string | undefined, expected: string): boolean => normalize(value) === expected;
  if (same(parts[0], ".astro") && !same(parts[1], "exports")) {
    throw new Error("caminho reservado do harness; use .astro/exports");
  }
  return path;
}

/** Grava o Markdown de forma atômica e devolve o caminho. */
export function exportSession(snapshot: SessionSnapshot, cwd: string, target?: string): string {
  const path = exportPath(cwd, snapshot, target);
  if (target !== undefined && existsSync(path)) {
    throw new Error("arquivo já existe; escolha outro caminho");
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, renderMarkdown(snapshot), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp não chegou a existir
    }
    throw error;
  }
  return path;
}
