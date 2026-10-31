/**
 * JSONL append-only: escrita durável e leitura tolerante a cauda parcial (I-04).
 *
 * `appendDurable` força o flush do arquivo antes de devolver, então a linha
 * sobrevive a uma queda do processo. A leitura descarta a última linha ilegível
 * apenas quando o arquivo não termina em newline — o resto de um append
 * interrompido; qualquer outra linha ilegível é corrupção.
 */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

/** Anexa uma linha e faz fsync antes de devolver. */
export function appendDurable(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    const buffer = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Divide o texto em linhas não vazias. */
export function jsonlLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export interface ParsedJsonl<T> {
  entries: T[];
  /** A última linha foi descartada por JSON inválido (append interrompido). */
  droppedTail: boolean;
}

/**
 * Faz parse de cada linha. Só a última pode falhar, e apenas quando o arquivo
 * não termina em newline — assinatura de append interrompido; nesse caso ela é
 * descartada. Linha ilegível no meio do arquivo, ou última linha completa
 * (terminada em newline) que não faz parse, é corrupção e vira erro.
 * `label` nomeia o arquivo na mensagem.
 */
export function parseJsonl<T>(text: string, label: string): ParsedJsonl<T> {
  const lines = jsonlLines(text);
  const completeTail = /\r?\n$/.test(text);
  const entries: T[] = [];
  let droppedTail = false;
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      if (index < lines.length - 1 || completeTail) {
        throw new Error(`${label}: linha ${index + 1} ilegível`);
      }
      droppedTail = true;
    }
  }
  return { entries, droppedTail };
}
