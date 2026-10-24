import { createHash } from "node:crypto";

/** Resultado registrado no journal; estruturalmente idêntico ao ToolResult. */
export interface JournalResult {
  output: string;
  isError?: boolean;
}

/**
 * call_id determinístico (F-03): SHA-256 de `run|step|name|arguments`.
 *
 * - O `id` do provider NÃO entra: pode variar entre tentativas e fallbacks.
 * - `step` entra: a mesma chamada em step diferente re-executa, para que uma
 *   leitura pós-escrita nunca sirva resultado velho.
 * - Determinístico (I-06): mesma entrada, mesma saída, em qualquer processo.
 */
export function callId(
  run: string,
  step: number,
  call: { name: string; arguments: string },
): string {
  return createHash("sha256")
    .update(`${run}|${step}|${call.name}|${call.arguments}`)
    .digest("hex");
}

/**
 * Journal de resultados por call_id, por sessão (F-03).
 *
 * - Em memória: não persiste nada; persistência é papel do audit/ledger (I-03/I-04).
 * - Primeiro resultado vence: `record` não sobrescreve (dedup estável).
 * - Escopo da sessão: journals nunca cruzam sessões, mesmo com o mesmo `run`.
 */
export class CallJournal {
  readonly #entries = new Map<string, JournalResult>();

  record(id: string, result: JournalResult): void {
    if (!this.#entries.has(id)) this.#entries.set(id, result);
  }

  lookup(id: string): JournalResult | undefined {
    return this.#entries.get(id);
  }
}
