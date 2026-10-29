/** Headers de MCP: referência `env:NOME` mantém o segredo fora da config (I-03). */
import { isAuthHeader, looksLikeSecret } from "../secrets";
import { MCPError } from "./types";

const ENV_REF = /^env:([A-Z_][A-Z0-9_]*)$/;

/** Nome da variável quando o valor é `env:NOME`; `undefined` para valor literal. */
export function headerEnvName(value: string): string | undefined {
  return ENV_REF.exec(value)?.[1];
}

/**
 * Resolve as referências `env:NOME` para o header final. O valor resolvido só
 * existe no transporte; a mensagem de erro cita o nome da variável, nunca o valor.
 */
export function resolveMcpHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (!value.startsWith("env:")) {
      if (isAuthHeader(name) || looksLikeSecret(value)) {
        throw new MCPError(`header "${name}" parece conter credencial; use "env:NOME_DA_VARIAVEL"`);
      }
      resolved[name] = value;
      continue;
    }
    const envName = headerEnvName(value);
    if (envName === undefined) {
      throw new MCPError(`header "${name}" usa env: com nome de variável inválido`);
    }
    const secret = env[envName];
    if (secret === undefined || secret.trim() === "") {
      throw new MCPError(`variável de ambiente ${envName} não definida para o header "${name}"`);
    }
    resolved[name] = secret;
  }
  return resolved;
}
