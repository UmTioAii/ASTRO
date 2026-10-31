import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock";
import { appendDurable, parseJsonl } from "./jsonl";
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
    // Seq + append na mesma seção crítica (I-04): dois processos no mesmo cwd
    // não repetem seq; sem lock, falha em vez de gravar duplicado.
    return withFileLock(`${this.path}.lock`, () => {
      const event: AuditEvent = {
        seq: Math.max(this.nextSeq, this.readLastSeq() + 1),
        ts: new Date().toISOString(),
        run: e.run,
        ...(e.agent === undefined ? {} : { agent: e.agent }),
        tipo: e.tipo,
        payload: e.payload ?? {},
      };
      this.nextSeq = event.seq + 1;
      const sanitized = sanitize(event) as AuditEvent;
      appendDurable(this.path, `${JSON.stringify(sanitized)}\n`);
      if (this.onEvent !== undefined) this.onEvent(sanitized);
      return sanitized;
    }, { failClosed: true });
  }

  readAll(): AuditEvent[] {
    return this.parseLines();
  }

  /** Lê o arquivo; ausente vira texto vazio. */
  private readText(): string {
    try {
      return readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return "";
      throw error;
    }
  }

  /** Eventos legíveis; cauda parcial de append interrompido é descartada. */
  private parseLines(): AuditEvent[] {
    return parseJsonl<AuditEvent>(this.readText(), `auditoria em "${this.path}"`).entries;
  }

  private readLastSeq(): number {
    const lines = this.parseLines();
    if (lines.length === 0) return 0;

    const last = lines[lines.length - 1] as unknown;
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
