/** Persistência sanitizada da sessão de chat (T1): schema 1, escrita atômica. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const SECRET_KEY = /(api[-_]?key|access[-_]?key|token$|secret|password)/i;

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
