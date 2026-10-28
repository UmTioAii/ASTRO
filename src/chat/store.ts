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

export class SessionStore {
  constructor(readonly root: string) {}

  /** Grava a sessão sanitizada; nome `<startedAt>-<id>.json`, atômico (tmp+rename). */
  write(snapshot: Omit<SessionRecord, "schemaVersion">): string {
    mkdirSync(this.root, { recursive: true });
    const stamp = snapshot.startedAt.replace(/[:.]/g, "-");
    if (!/^[A-Za-z0-9-]+$/.test(snapshot.id) || !/^[A-Za-z0-9-]+$/.test(stamp)) {
      throw new Error("sessão com id/startedAt inválido para o nome do arquivo");
    }
    const path = join(this.root, `${stamp}-${snapshot.id}.json`);
    const tmp = `${path}.tmp`;
    const record: SessionRecord = { schemaVersion: 1, ...snapshot };
    writeFileSync(tmp, redactSecrets(JSON.stringify(record, null, 2)), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    return path;
  }
}
