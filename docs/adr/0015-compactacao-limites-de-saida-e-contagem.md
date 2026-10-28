# ADR-0015: compactação de sessão, limites de saída e contagem de tokens por provider

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-10, D-21, ADR-0010, ADR-0014

## Contexto

Janelas de contexto são finitas. A parte de compactação de F-08 (CMP-1..12) precisa de artefato próprio — `HandoffArtifactV1` carrega só `compaction?`/`truncated`/contagens — e depende de contagem de tokens por provider, que precisa de ID novo: D-18 é a taxonomia de erros (Q-06 veta o reuso).

## Decisão

**Gatilho e parte recente (CMP-1, CMP-2).** Compacta quando a estimativa atinge `window − reserve`; sem `buffer`, reserve = max(15% da janela, 16.000); buffer explícito substitui o default e é ignorado se ≥ janela. A parte recente tem 15.000 tokens de mensagens, sem system prompt nem `AGENTS.md`, cortada no início de mensagem de usuário; contada pelo tokenizer do modelo ativo, senão 4 chars/token marcado estimate.

**Integridade e artefato (CMP-3, CMP-4, CMP-5).** Nunca compacta no meio do par tool call/result. `CompactionArtifactV1` (`src/compaction/types.ts`) com seções Active, Blocked, Next Move, Relevant Files (máx 15), Important Context; campos compartilhados com handoff são copiados; o pedido de resumo não chama tools. Redução em 5 níveis: full → outputs clipados (2.000 head + 2.000 tail) → outputs removidos e inputs clipados → só texto do usuário clipado → omitido.

**Breaker e retry (CMP-6, CMP-7).** 3 falhas consecutivas → pausa de 5 min com `Compaction paused (3 failures, retry in Xs)`; `/compact force` retenta, registra `compaction.manual` e zera o contador, que vive no ledger (`compaction.failure_count`) e sobrevive a `--resume` segurando `compaction_paused`. Rejeição por tamanho do provider → compacta e retenta UMA vez; segunda rejeição → erro. `AGENTS.md` volta ao contexto após compactar (CMP-8); compactação em background é v2 (CMP-9, #138).

**Limites de saída (CMP-10..12).** Cap por saída = min(8000 tokens, 5% da janela); excedente vira arquivo com head, tail e referência de fonte (path/URL/tool-call id; irrecuperável → `truncated_unrecoverable`). `read_file` pagina 350 linhas com overlap 10; `grep` ganha `page` com `{results, total, page, hasMore}`.

**Contagem por provider (Q-06).** A contagem ganha o ID novo **D-21** em `docs/decisions.md`: pura, determinística, sem chamadas a provider e sem segredo (I-03); tokenizer nativo quando existir, estimativa 4 chars/token marcada; nunca reporta zero quando desconhecida. A linha de D-21 na tabela e o ajuste de `roadmap-complementar` ficam no PR de S-19 (#136).

**Ledger.** Este ADR é dono do kind `compaction`: `failure_count`, `manual` (schema em #122).

## Consequências

- Ganho: sessões longas cabem na janela com corte previsível e breaker persistente.
- Custo: S-17 (#134) compacta, S-16 (#133) limita saídas, S-19 (#136) conta; config ganha `outputLimit`.
- Invariantes afetadas: I-03 (artefato e saídas sanitizados), I-19 (breaker sobrevive ao resume).

## Alternativas descartadas

- Reusar `HandoffArtifactV1`: não tem as seções de compaction; carrega campos de handoff.
- Contagem como parte de D-18: Q-06 veta — taxonomia de erros ≠ contagem de tokens.
- Compactar no meio do par tool call/result: perde o resultado em voo.
