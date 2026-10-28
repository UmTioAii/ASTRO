# Invariantes

Objetivo: base normativa do que não pode ser violado no ASTRO; cada invariante tem critério verificável.

| Cobre | Não cobre |
|---|---|
| Regras I-01 a I-22 e a cobertura atual no código | Arquitetura (em `docs/adr/`) e decisões (em `docs/decisions.md`) |

Fonte da verdade: `02-estrutura-correta.md` da trilha de planejamento. A tabela abaixo é a reconciliação com essa fonte; a coluna "Cobertura" cita o que o repo já garante (com caminho) e o que é pendente (com ID de roadmap ou issue).

## Tabela normativa

| ID | Invariante | Cobertura no repo |
|---|---|---|
| I-01 | Todo agente declara papel, tools, pool de modelos, orçamento e sandbox; nada fora da declaração é acessível | Parcial: allowlist negada por padrão (`src/tools/executor.ts:72`); declaração completa de papéis pendente (#58) |
| I-02 | Subagente tem escopo igual ou menor que o pai; nunca maior | Pendente (#58) |
| I-03 | Segredos nunca entram em contexto de modelo, log, cache, auditoria ou memória; só `credentialRef` | `tests/provider.test.ts`, `tests/audit.test.ts`, `tests/app.test.ts:52`; pendência: env herdado pelo `run_command` sem sandbox (`F-00`) |
| I-04 | Toda decisão relevante gera evento de auditoria sanitizado | Coberto: `src/audit.ts:21` (`sanitize`); trocas emitem `swap.requested/approved/denied/pending` e `run.stopped` |
| I-05 | Contrato antes de código; módulo sem contrato e critério não entra | `docs/workflow.md:7` (issue com critério testável) |
| I-06 | Placement reproduzível: mesmo run + mesma semente, mesma escolha de modelo e credencial | Pendente (#60) |
| I-07 | Unidade de placement é `(provider, modelo, credencial)`; cota agregada por conta/org | Parcial: `quotaDomain` (`src/config.ts`); pool de credenciais pendente (C6/#60) |
| I-08 | Nenhuma troca silenciosa de credencial, provider ou modelo; toda troca exige aprovação humana | Coberto: fallback de provider/profile e handoff multi-agent (novo e retomada) passam por `approveSwap` (`src/approval.ts`, `src/session.ts`); sem TTY fica `pending` e o run para |
| I-09 | Erro é classificado antes de qualquer ação; cota dura não é retentada | `src/provider/types.ts:42` (classes); `src/quota.ts` (`hard_quota` sem retry) |
| I-10 | Leitor/planejador usa workspace compartilhado read-only; escritor usa worktree próprio; nunca dois escritores no mesmo worktree | Parcial: worktrees no fluxo de dev (`docs/workflow.md:16`); papéis de agente pendentes (#58) |
| I-11 | Worktree não é fronteira de segurança; execução exige sandbox de FS/rede | Parcial: confinamento de caminho (`src/tools/paths.ts:8`) e sandbox opcional (`src/tools/run-command.ts:107`); pendências: env herdado e symlink (`F-00`) |
| I-12 | Toda tool declara nome, schemas, classe de risco, permissão, timeout, retry e formato de erro | Parcial: manifesto validado (`src/sdk/tool.ts:22`); formato de erro pendente |
| I-13 | Plugin tem manifesto, permissões explícitas e roda em processo separado | Parcial: manifesto e falha isolada (`src/plugins.ts`); processo separado pendente |
| I-14 | Skill não amplia permissão; só sugere tools que o agente já tem | Pendente (#55) |
| I-15 | MCP é registrado como plugin de tool, com namespace, e a saída é dado não confiável | Pendente (#56) |
| I-16 | Toda escrita de arquivo é diff revisável e reversível; nenhuma escrita direta sem registro | Parcial: `edit` com backup e rollback (`src/tools/edit.ts:218`); `write_file` direto, deprecação em ADR (ver `F-04`/`F-16`) |
| I-17 | Orçamento tem corte físico, não só aviso | Coberto: quota/team + `src/budget.ts` (`enforceBudget`: onExceed, hardCeiling, não-interativo com checkpoint); reserva da cadeia na parte 4 (`#132`) |
| I-18 | Comunicação entre agentes passa pelo orquestrador; não há canal peer-to-peer | Parcial: handoff via orquestrador (`src/session.ts:54`); blackboard pendente (C4/#58) |
| I-19 | Negação de aprovação ou esgotamento de opções termina em parada graciosa com checkpoint | Parcial: cancelamento em ponto seguro e retomada determinística por agente via ledger (`src/resume.ts`, `astro resume`); breaker de compactação pendente (S-17/#134) |
| I-20 | Modelo 1 para modelo 2 sem mudar os contratos de orquestrador, placement, pool e aprovação | Parcial: `Provider` abstrato (`src/provider/types.ts:36`) |
| I-21 | Tags de modelo são vocabulário fechado, curadas na origem, com `fonte` e `verificado` | Parcial: vocabulário fechado (`src/tags.ts:8`); `fonte`/`verificado` só em `price` |
| I-22 | Substituição cross-provider só ocorre dentro de uma classe de equivalência declarada e com aprovação | Pendente (#60, `F-19`) |

## Numeração

Comentários de código e issues citam I-01, I-03, I-11 e I-12 com os significados acima. As citações de "I-11" para confinamento de caminho referem-se à cláusula de sandbox de FS do I-11; a lacuna de symlink é pendência registrada em `F-00`.
