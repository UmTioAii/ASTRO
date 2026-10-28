# ASTRO — instruções para agentes

Leia só este arquivo no início. Os demais documentos são carregados sob demanda pelo mapa em `docs/INDEX.md`.

## Projeto

ASTRO é um harness CLI local, em Bun + TypeScript strict, multi-provider, com foco em governança: escopo por agente, custo e quota por conta, aprovação e auditoria. Zero dependências de runtime.

## Comandos

- `bun install --frozen-lockfile`
- `bun test` — suíte completa
- `bun run typecheck` — `tsc --noEmit`
- Antes de qualquer PR: os dois acima passam, sem exceção.

## Mapa do código

- `src/provider/` — adaptadores de modelo (openai-compat, codex-oauth)
- `src/tools/` — ferramentas e confinamento de caminho
- `src/audit.ts`, `src/ledger.ts` — auditoria e custo
- `src/app.ts`, `src/session.ts`, `src/cli.ts` — orquestração
- `tests/` — espelha `src/`

## Regras inegociáveis

Detalhes e IDs em `docs/invariants.md`.

- Segredo só entra por variável de ambiente nomeada. Nunca aparece em log, audit, ledger, erro ou prompt (I-03).
- Negar por padrão: tool fora da allowlist não executa (I-01).
- Caminho de arquivo fica dentro do `cwd` salvo regra explícita (I-11).
- Prompt do usuário não é persistido. Só `taskHash`.
- Mudança de comportamento exige teste que falha antes (RED) e passa depois (GREEN). O RED vai para a descrição do PR.

## Fluxo (resumo)

Detalhe completo em `docs/workflow.md`.

1. Toda mudança tem issue (`#n`). Critério de aceite na issue.
2. Branch a partir de `main` atualizada: `<tipo>/<n>-<slug>`, por exemplo `feat/14-pool-placement`.
3. Commits no formato `tipo: resumo`, com rodapé `Refs #n`.
4. PR pelo template, com `Closes #n`. Alvo de até 200 linhas alteradas, teto de 400.
5. Revisão obrigatória antes do merge, feita por quem não escreveu o código. Ver `docs/review-checklist.md`.
6. Squash merge. `main` nunca recebe commit direto.

## Revisão de PR (obrigatória)

- Nenhum PR entra em `main` sem veredito registrado no próprio PR: `Revisão: APPROVE` ou `Revisão: REQUEST_CHANGES`.
- Revisor em contexto novo: subagente ou sessão que recebe o diff e o checklist, não o raciocínio do autor.
- Achado bloqueante cita `arquivo:linha` e um cenário concreto de falha. Achado sem isso é sugestão e não bloqueia.
- Achado de segurança (vazamento de segredo, bypass de allowlist, escape de caminho) bloqueia sempre.
- Após correção, a nova revisão cobre só o commit novo, não o PR inteiro.

## Documentação

Estas regras existem para reduzir o custo de tokens ao ler o projeto.

- Um assunto tem um arquivo dono. Outros arquivos linkam, não copiam.
- Documento começa com o resumo de uma linha. Quem lê só o início decide se precisa do resto.
- Prefira tabela e lista a prosa. Sem repetir o que já está no código ou no teste.
- Referências por ID estável, nunca por número de linha: `D-13` (decisão), `I-03` (invariante), `#14` (issue), `ADR-0007` (decisão arquitetural).
- Mudou comportamento, atualize o doc afetado no mesmo PR.
- Edição pontual. Não reescreva um arquivo inteiro para mudar uma linha.
- Limites: arquivo de doc até 150 linhas; ADR até 60 linhas. Acima disso, dividir.
- Novo arquivo em `docs/` entra no `docs/INDEX.md` no mesmo PR.
- Idioma: docs em português; identificadores de código em inglês; mensagens de erro para o usuário em português. Artefatos de colaboração (commits e título/corpo/comentários de PR e issue) em inglês; relatórios no chat para o usuário em português.

## Não fazer

- Não criar arquivo de estado de projeto (ex.: `progress.md`). Estado vive nas issues e milestones.
- Não adicionar dependência de runtime sem ADR.
- Não ler `docs/` inteiro. Use `docs/INDEX.md` e abra só o que a tarefa exige.
- Não incluir link de sessão nem atribuição de ferramenta em commit, PR, issue, doc ou log. Menção a ferramenta só em revisão de PR, como “Claude Code”, sem modelo nem sessão.
