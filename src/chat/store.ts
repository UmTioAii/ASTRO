/** Persistência sanitizada da sessão de chat (T1): schema 1, escrita atômica. */
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ChatMessage } from "../provider/types";
import { redactSecrets } from "../sanitize-external";

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  model: string;
  messages: ChatMessage[];
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

const SECRET_KEY = /(token(?!s)|secret|password|api[-_]?key|access[-_]?key)/i;

export interface SessionSummary {
  path: string;
  id: string;
  startedAt: string;
  model: string;
  turns: number;
  costUsd: number | null;
}

const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Valida um registro vindo do disco (pode ter sido editado à mão). */
function parseRecord(raw: unknown): SessionRecord {
  if (raw === null || typeof raw !== "object") throw new Error("registro de sessão inválido");
  const record = raw as Partial<SessionRecord>;
  if (record.schemaVersion !== 1) throw new Error("schema de sessão não suportado");
  if (typeof record.id !== "string" || !/^[A-Za-z0-9-]+$/.test(record.id)) throw new Error("id de sessão inválido");
  if (typeof record.startedAt !== "string" || Number.isNaN(Date.parse(record.startedAt))) throw new Error("início de sessão inválido");
  if (typeof record.model !== "string" || record.model === "") throw new Error("modelo da sessão inválido");
  if (!Array.isArray(record.messages)) throw new Error("mensagens da sessão inválidas");
  const messages = record.messages.map((message) => {
    if (message === null || typeof message !== "object") throw new Error("mensagem de sessão inválida");
    const item = message as Partial<ChatMessage>;
    if (typeof item.role !== "string" || !ROLES.has(item.role) || typeof item.content !== "string") {
      throw new Error("mensagem de sessão inválida");
    }
    if (item.toolCallId !== undefined && typeof item.toolCallId !== "string") {
      throw new Error("toolCallId de sessão inválido");
    }
    return item as ChatMessage;
  });
  const number = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} da sessão inválido`);
    return value;
  };
  const costUsd = record.costUsd === null || record.costUsd === undefined
    ? null
    : number(record.costUsd, "custo");
  return {
    schemaVersion: 1,
    id: record.id,
    startedAt: record.startedAt,
    model: record.model,
    messages,
    turns: number(record.turns, "turnos"),
    tokensIn: number(record.tokensIn, "tokens"),
    tokensOut: number(record.tokensOut, "tokens"),
    costUsd,
  };
}

/** Sanitiza strings JSON estruturalmente (inclusive `toolCalls.arguments`). */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(item),
    ]));
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.stringify(sanitizeValue(JSON.parse(text)));
    } catch {
      // não era JSON: cai na redação textual
    }
  }
  return redactSecrets(value);
}

export class SessionStore {
  constructor(readonly root: string) {}

  /** Sessões gravadas, mais recentes primeiro; arquivos inválidos são ignorados. */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.root, name);
      try {
        const record = this.#read(path);
        out.push({
          path, id: record.id, startedAt: record.startedAt, model: record.model,
          turns: record.turns, costUsd: record.costUsd,
        });
      } catch {
        // arquivo corrompido ou de outro schema: não aparece na lista
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Carrega por id, índice não é aceito aqui; aceita também um nome `.json` relativo. */
  load(ref: string): { record: SessionRecord; path: string } {
    const found = this.list().find((item) => item.id === ref);
    const path = found?.path ?? (ref.endsWith(".json") ? this.#inside(ref) : undefined);
    if (path === undefined) throw new Error(`sessão "${ref}" não encontrada`);
    return { record: this.#read(path), path };
  }

  #inside(path: string): string {
    const root = resolve(this.root);
    const candidate = resolve(root, path);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error("caminho de sessão fora do diretório");
    }
    return candidate;
  }

  #read(path: string): SessionRecord {
    const real = realpathSync(path);
    const root = realpathSync(this.root);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("caminho de sessão fora do diretório");
    const raw: unknown = JSON.parse(readFileSync(real, "utf8"));
    return sanitizeValue(parseRecord(raw)) as SessionRecord;
  }

  /** Grava a sessão sanitizada; nome `<startedAt>-<id>.json`, atômico (tmp+rename). */
  write(snapshot: Omit<SessionRecord, "schemaVersion">): string {
    const stamp = snapshot.startedAt.replace(/[:.]/g, "-");
    if (!/^[A-Za-z0-9-]+$/.test(snapshot.id) || !/^[A-Za-z0-9-]+$/.test(stamp)) {
      throw new Error("sessão com id/startedAt inválido para o nome do arquivo");
    }
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, `${stamp}-${snapshot.id}.json`);
    const tmp = `${path}.tmp`;
    const record = sanitizeValue({ schemaVersion: 1, ...snapshot }) as SessionRecord;
    writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    return path;
  }
}

export function sessionSummaryLine(item: SessionSummary, index: number): string {
  const cost = item.costUsd === null ? "n/d" : `US$ ${item.costUsd.toFixed(6)}`;
  return `${index + 1}. ${item.startedAt} ${item.id} ${item.model} turnos=${item.turns} custo=${cost}`;
}