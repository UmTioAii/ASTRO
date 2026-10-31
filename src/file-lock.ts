/**
 * Lock de arquivo cross-process (F-26, A4): exclusão por `open(..., "wx")`,
 * remoção de lock órfão e falha fechada por padrão quando a disputa estoura o
 * timeout. O dono grava o PID.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

export const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
const STALE_LOCK_MS = 5_000;
/** Espera síncrona entre tentativas (o fluxo é síncrono). */
const RETRY_WAIT_MS = 5;
/** Lock de arquivo não pôde ser adquirido e a operação exige exclusividade (A4). */
export class FileLockError extends Error {
  readonly code = "lock_timeout";
  constructor(message: string) {
    super(message);
    this.name = "FileLockError";
  }
}
/** O processo ainda existe? Sinal 0 não entrega nada; EPERM também prova vida. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Conteúdo e mtime de um lock órfão (token de remoção segura). */
function staleLock(
  lockPath: string,
  timeoutMs: number,
): { content: string; mtimeMs: number } | undefined {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(lockPath, "utf8").trim();
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return undefined; // sumiu: a próxima tentativa decide
  }
  const pid = /^\d+$/.test(content) ? Number(content) : undefined;
  const stale = pid !== undefined && pid !== process.pid
    ? !processAlive(pid)
    // Sem PID (crash entre create e write) ou dono é este processo: só expira.
    : Date.now() - mtimeMs > Math.max(STALE_LOCK_MS, timeoutMs * 2);
  return stale ? { content, mtimeMs } : undefined;
}

/**
 * Remove o lock só se ainda for exatamente o observado: reconferir conteúdo e
 * mtime fecha a janela em que outro processo substitui o lock antes do unlink.
 */
function removeIfUnchanged(
  lockPath: string,
  observed: { content: string; mtimeMs: number },
): boolean {
  try {
    const content = readFileSync(lockPath, "utf8").trim();
    const mtimeMs = statSync(lockPath).mtimeMs;
    if (content !== observed.content || mtimeMs !== observed.mtimeMs) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Serializa uma seção crítica com lock de arquivo. */
export function withFileLock<T>(
  lockPath: string,
  critical: () => T,
  opts: { failClosed?: boolean; timeoutMs?: number } = {},
): T {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx"); // exclusivo: falha se outro processo segura o lock
    } catch {
      fd = undefined;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, String(process.pid));
        return critical();
      } finally {
        try {
          closeSync(fd);
        } finally {
          // Só apaga se o lock ainda é nosso: um sucessor não pode ser removido.
          try {
            if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
              rmSync(lockPath, { force: true });
            }
          } catch {
            // já removido por outro caminho
          }
        }
      }
    }
    const stale = staleLock(lockPath, timeoutMs);
    if (stale !== undefined && removeIfUnchanged(lockPath, stale)) continue;
    if (Date.now() >= deadline) {
      if (opts.failClosed !== false) {
        throw new FileLockError(`lock "${lockPath}" indisponível após ${timeoutMs}ms`);
      }
      return critical(); // melhor esforço explícito (CAS de handoff, ADR-0006)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MS);
  }
}
