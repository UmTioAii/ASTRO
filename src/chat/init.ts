/** `/init`: cria um AGENTS.md inicial no cwd sem sobrescrever o existente. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_TEMPLATE = `# AGENTS

## Projeto

Descreva o objetivo e o que este repositório entrega.

## Comandos

- instalar:
- testar:
- typecheck:

## Regras

- Nenhum segredo em log, erro, commit ou prompt.
- Mudança de comportamento exige teste que falha antes e passa depois.
- Caminhos ficam dentro do diretório de trabalho.

## Não fazer

- Não criar arquivo de estado de projeto.
`;

export function initAgents(cwd: string): string {
  const path = join(cwd, "AGENTS.md");
  try {
    writeFileSync(path, AGENTS_TEMPLATE, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("AGENTS.md já existe; nada foi alterado");
    }
    throw error;
  }
  return path;
}
