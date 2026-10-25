import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./sanitize-external";

export interface AuditEvent {
  seq: number;
  ts: string;
  run: string;
  agent?: string;
  tipo: string;
  payload: Record<string, unknown>;
}

const SECRET_KEY = /(^|[-_])(api[-_]?)?keys?$|tokens?$|secret|password|authorization/i;
const REDACTED = "[REDACTED]";

/**
 * Sanitiza recursivamente um valor: chaves que sugerem credenciais e strings
 * no formato de chave de API são substituídas por "[REDACTED]".
 */
export function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) && typeof child !== "number" ? REDACTED : sanitize(child),
      ]),
    );
  }

  return value;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Log de auditoria append-only em JSONL, com segredos redigidos. */
export class Auditor {
  private readonly path: string;
  private nextSeq: number;
  /** Callback opcional para observabilidade (F6-1: metrics). */
  private readonly onEvent?: (event: AuditEvent) => void;

  constructor(path: string, opts?: { onEvent?: (event: AuditEvent) => void }) {
    this.path = path;
    this.onEvent = opts?.onEvent;
    mkdirSync(dirname(path), { recursive: true });
    this.nextSeq = this.readLastSeq() + 1;
  }

  append(e: {
    run: string;
    agent?: string;
    tipo: string;
    payload?: Record<string, unknown>;
  }): AuditEvent {
    const event: AuditEvent = {
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      run: e.run,
      ...(e.agent === undefined ? {} : { agent: e.agent }),
      tipo: e.tipo,
      payload: e.payload ?? {},
    };
    const sanitized = sanitize(event) as AuditEvent;
    appendFileSync(this.path, `${JSON.stringify(sanitized)}\n`, "utf8");
    if (this.onEvent !== undefined) this.onEvent(sanitized);
    return sanitized;
  }

  readAll(): AuditEvent[] {
    return this.readLines().map((line) => JSON.parse(line) as AuditEvent);
  }

  private readLines(): string[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }

  private readLastSeq(): number {
    const lines = this.readLines();
    if (lines.length === 0) return 0;

    const last: unknown = JSON.parse(lines[lines.length - 1]);
    if (
      typeof last !== "object" ||
      last === null ||
      typeof (last as { seq?: unknown }).seq !== "number"
    ) {
      throw new Error(`auditoria em "${this.path}" termina com um evento sem "seq" válido`);
    }
    return (last as AuditEvent).seq;
  }
}
