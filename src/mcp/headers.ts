/** Headers de MCP: referência `env:NOME` mantém o segredo fora da config (I-03). */
import { isAuthHeader, looksLikeSecret } from "../secrets";
import { MCPError } from "./types";

const ENV_REF = /^env:([A-Z_][A-Z0-9_]*)$/;
/** Token grammar de nome de header (RFC 7230). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Nome de header válido; rejeita espaço, `:` e caracteres de controle. */
export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME.test(name);
}

/** Nome da variável quando o valor é `env:NOME`; `undefined` para valor literal. */
export function headerEnvName(value: string): string | undefined {
  return ENV_REF.exec(value)?.[1];
}

/** Nomes de variáveis referenciadas por headers `env:NOME` (para sanitizar o shell/stdio). */
export function headerEnvNames(headers: Record<string, string> | undefined): string[] {
  if (headers === undefined) return [];
  return Object.values(headers).flatMap((value) => {
    const name = headerEnvName(value);
    return name === undefined ? [] : [name];
  });
}

function assertHeaderValue(name: string, value: string): void {
  // Só ASCII imprimível: CR/LF/NUL forjariam log e não-ASCII faz o fetch ecoar o valor.
  if (!/^[\u0020-\u007e]*$/.test(value)) {
    throw new MCPError(`header "${name}" contém caractere de controle ou fora de ASCII imprimível`);
  }
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
    if (!isValidHeaderName(name)) {
      throw new MCPError(`nome de header inválido: "${name}"`);
    }
    if (!value.startsWith("env:")) {
      if (isAuthHeader(name) || looksLikeSecret(value)) {
        throw new MCPError(`header "${name}" parece conter credencial; use "env:NOME_DA_VARIAVEL"`);
      }
      assertHeaderValue(name, value);
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
    assertHeaderValue(name, secret);
    resolved[name] = secret;
  }
  return resolved;
}
