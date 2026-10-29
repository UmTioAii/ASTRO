import { delimiter } from "node:path";

/**
 * Ambiente do smoke: remove TODA grafia de PATH (o Windows expõe `Path`) e fixa
 * só os diretórios do sistema, para o launcher não achar um Bun global.
 */
export function smokeEnv(
  base: Record<string, string | undefined>,
  dirs: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toLowerCase() === "path") continue;
    env[key] = value;
  }
  env.PATH = dirs.join(delimiter);
  return env;
}
