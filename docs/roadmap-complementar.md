# Roadmap complementar — camadas 0 a 3

Objetivo: itens planejados das camadas de fundação, interface, capacidades e polimento, com dependências e bloqueios.

| Cobre | Não cobre |
|---|---|
| F-xx (Camada 0), T1–T4, C1–C7, P-01–P-04 | Fases concluídas (em `docs/roadmap.md`) |

## Camadas

| Camada | Conteúdo | Marco |
|---|---|---|
| 0 — fundação | F-00 a F-22 | M0 fundação |
| 1 — interface | T1–T4 (#62–#65) | M1 interface |
| 2 — capacidades | C1–C7 (#55–#61) | M2 capacidades |
| 3 — polimento | P-01–P-04 | M3 polimento |

Status possíveis: `concluído`, `em andamento`, `planejado`, `bloqueado`.

## Camada 0 — fundação

| ID | Título | Status | Issue | Depende de | Bloqueia |
|---|---|---|---|---|---|
| F-00 | Rebase dos fixes de segurança (env herdado no run_command; escape por symlink no read_file) | concluído | #67 | — | C2, C3 |
| F-01 | Política de ação por classe de erro (D-14/D-18) | concluído | #69 | — | C6 |
| F-02 | Ledger com schemaVersion, estado de execução e hash de chamadas | concluído | #73 | ADR-0002 | F-03, F-04, F-05, F-06, F-07, F-08, F-17, F-19, F-22, C7, T4 |
| F-03 | Idempotência de tool calls por `call_id` determinístico | concluído | #88 | F-02 | F-06, F-10, F-20, C2, C6 |
| F-04 | Snapshots de escrita no write_file (ponte; deprecação via ADR) | planejado | — | F-02 | F-16 |
| F-05 | Limites de execução por tarefa com corte físico (I-17) | planejado | — | F-02 | C4, C7 |
| F-06 | Cancelamento consistente e retomada explícita (I-19) | planejado | — | F-02, F-03 | F-18, F-19, T2 |
| F-07 | Matriz de capability por modelo, consultada antes da escolha | concluído | #81 | F-02 | F-08, C4, C6, F-27 |
| F-08 | Estratégia de context overflow com contagem por provider (D-22) | em andamento | #136 | F-02, F-07 | T1 |
| F-09 | Sanitização de conteúdo externo antes de logar e de entrar no contexto | concluído | #70 | — | C2, C3, F-11 |
| F-10 | Manifesto estendido: `idempotent` e `sideEffects` (I-12) | concluído | #93 | F-03 | C1, C2, F-14, F-15, F-16 |
| F-11 | Limites de saída por tool com metadados de truncamento | planejado | — | F-09 | F-14, F-15, C3 |
| F-12 | ADR de dependências de runtime | concluído | #63 | — | T2 |
| F-14 | `git_status` e `git_diff` estruturadas | planejado | — | F-11 | C5, T3 |
| F-15 | `run_tests` (fonte do gate de conclusão) | planejado | — | F-11 | C5 |
| F-16 | `apply_patch` multi-arquivo atômico (alvo do I-16) | planejado | — | F-04, F-09 | ADR de deprecação do write_file |
| F-17 | `todo_write` (checkpoint de handoff) | planejado | — | F-02 | C4, T2 |
| F-18 | `ask_user` (gate de confirmação) | planejado | — | F-06 | T2 |
| F-19 | Gate de aprovação de troca de credencial/provider/modelo (I-08, escada D-12) | planejado | — | F-02, F-06 | C6 |
| F-20 | Microcompactação determinística de resultados de tool | planejado | — | F-02, F-03 | F-21 |
| F-21 | Checkpoint de contexto com verificação de preservação de identificadores | planejado | — | F-17, F-20 | T4 |
| F-22 | Log de eventos de sessão e resume determinístico (núcleo do T4) | planejado | — | F-02, F-06 | T4 |
| F-23 | HandoffArtifact v1: artefato durável com handoff_id determinístico e checkpoint no ledger (ADR-0006) | concluído | #75 | F-02, ADR-0006 | F-24, F-25, F-26, C4 |
| F-24 | Handoff com ack de recebimento, timeout e retomada de pendentes | concluído | #76 | F-23, F-06 | C4 |
| F-25 | Compactação estruturada do handoff com source_refs e validação de artefatos | concluído | #77 | F-23, F-09 | C4 |
| F-26 | Lock de via única: CAS por handoff_id e verifier na recepção | concluído | #78 | F-23, F-03 | C4 |
| F-27 | Model pool declarativa: seção modelPool, profile → modelo, `astro pool list` (ADR-0007) | concluído | #82 | F-07, ADR-0007 | F-28, F-29, C4 |
| F-28 | AgentManager: ciclo de vida de agentes com profile e `astro agents list` | concluído | #83 | F-27 | F-29 |
| F-29 | Runtime com pool: profile no startup e no handoff; `profile` no ledger; from/to_profile no artefato | concluído | #84 | F-27, F-28, F-23, F-24, F-25, F-26 | F-30, C4 |
| F-30 | Custo atribuído por agente com granularidade de profile e `astro cost --by-agent` | concluído | #85 | F-29 | F-31 |
| F-31 | Health e fallback por profile estendendo C6 (ADR-0007) | concluído | #86 | F-30, C6 | — |

Nota: F-13 (`glob`) ficou fora por não ser confirmado como lacuna dos diferenciais (multi-agente, multi-provider, comunicação). Pode voltar como issue própria.

## Camada 1 — interface

| ID | Título | Status | Issue | Depende de | Bloqueia |
|---|---|---|---|---|---|
| T1 | REPL mínimo sem dependência nova | concluído | #62 | - | T2 |
| T2 | TUI com biblioteca de terminal; perfis de confirmação; painel de tarefas | em andamento | #63 | F-06, F-12, F-17, F-18 | T3, T4 |
| T3 | Streaming, temas e diff viewer | planejado | #64 | T2, F-14 | — |
| T4 | Sessões e memória com escopo definido | planejado | #65 | T2, F-21, F-22 | P-02, P-03 |

## Camada 2 — capacidades

| ID | Título | Status | Issue | Depende de | Bloqueia |
|---|---|---|---|---|---|
| C1 | Skills com manifesto e permissões (I-14) | concluído | #55 | F-02, F-10 | — |
| C2 | Cliente MCP com namespace e saída não confiável (I-15) | planejado | #56 | F-00, F-03, F-09, F-10 | — |
| C3 | `web_search` e `web_fetch` com bloqueio de destinos internos | planejado | #57 | F-00, F-09, F-11 | — |
| C4 | Perfis de agente, subagentes com escopo menor (I-02) e blackboard pelo orquestrador (I-18) | planejado | #58 | F-02, F-05, F-07, F-17, F-23, F-24, F-25, F-26 | P-02 |
| C5 | Gate de conclusão determinístico e golden tasks com N execuções | planejado | #59 | F-14, F-15 | P-01, P-04 |
| C6 | Fallback, pool de chaves com cooldown, classes de equivalência (I-22) | concluído | #60 | F-01, F-03, F-07, F-19 | P-01 |
| C7 | Módulos reorganizados, budget por sessão, perfis de ambiente | planejado | #61 | F-02, F-05 | P-01 |

C4 inclui o blackboard entre agentes como sub-itens: entradas tipadas (`fact`, `decision`, `task`, `question`, `artifact`, `result`), proveniência completa (agente, provider, modelo, step, `call_id`, hashes dos arquivos de origem), staleness por hash, projeção por agente com orçamento de tokens, resolução de conflito entre entradas e conteúdo externo marcado como não confiável (nunca promovido a `decision` automaticamente).

## Camada 3 — polimento

| ID | Título | Status | Issue | Depende de | Bloqueia |
|---|---|---|---|---|---|
| P-01 | Roteamento por custo, latência, qualidade ou rodízio | bloqueado | — | C5, C6, C7 | — |
| P-02 | Memória estruturada multi-agente (inbox JSONL) | bloqueado | — | C4, T4 | — |
| P-03 | Event store e replay de sessão multi-agente | bloqueado | — | F-02, T4 | — |
| P-04 | Verificações adicionais no gate de conclusão | bloqueado | — | C5 | — |

## Ordem de execução

| Ordem | Itens |
|---|---|
| 1 | F-00; em paralelo: F-01, F-09, ADR-0002 (ledger), ADR-0001 (dependências, F-12) |
| 2 | F-02 (após ADR-0002) |
| 3 | F-03, F-07, F-10; F-27 (após F-07, ADR-0007) |
| 4 | F-04, F-05, F-06, F-08, F-11; F-28 (após F-27) |
| 5 | F-14, F-15, F-16, F-17, F-18 |
| 6 | F-19, F-20, F-21, F-22; F-23 (após ADR-0006, de preferência após F-27 para from/to_profile); F-29 (após F-23..F-26, F-28); F-30 (após F-29) |
| 7 | T1 em paralelo com a Camada 0; F-24 (após F-23, F-06), F-25 (após F-23, F-09), F-26 (após F-23, F-03) |
| 8 | T2 (após F-06, F-12, F-17, F-18); T3 (após T2, F-14); T4 (após T2, F-21, F-22) |
| 9 | C1, C2, C3; C4, C6; C5; C7; F-31 (após C6, F-30) |
| 10 | P-01 a P-04 (após C5, C6, C7) |

## ADRs necessários

| ADR | Assunto | Antes de |
|---|---|---|
| ADR-0001 | Dependências de runtime — aceita em `docs/adr/0001-ink-tui-dependencia-de-runtime.md` | T2 |
| ADR-0002 | `schemaVersion` inteiro do ledger (config mantém semver, `src/config.ts:129`) | F-02 |
| ADR-0003 | Estrutura de módulos | C7 |
| ADR-0004 | Perfis de execução por ambiente | C7 |
| ADR-0005 | Deprecação do `write_file` direto em favor de `apply_patch` (I-16) | F-04, F-16 |
| ADR-0006 | Artefato de handoff durável (HandoffArtifact v1) no ledger | F-23 |
| ADR-0007 | Pool declarativa de modelos (profile → modelo, sem pricing duplicado) | F-27 |
