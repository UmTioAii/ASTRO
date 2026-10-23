import { resolve, sep } from "node:path";
import { ToolError } from "./types";

/**
 * Resolve `p` relativo a `cwd` e garante que o resultado fica dentro de `cwd`.
 * Lança `ToolError` (mensagem com "fora") para `../` e caminhos absolutos externos.
 */
export function resolveWithin(cwd: string, p: string): string {
  const root = resolve(cwd);
  const target = resolve(root, p);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ToolError(`caminho fora do diretório de trabalho: ${p}`);
  }
  return target;
}
