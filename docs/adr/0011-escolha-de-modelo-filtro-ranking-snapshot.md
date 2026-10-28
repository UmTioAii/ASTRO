# ADR-0011: escolha de modelo com filtro duro, ranking e snapshot reproduzível

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-10, D-15, ADR-0007, ADR-0008, ADR-0009

## Contexto

ADR-0008 deu ao orchestrator as tools de escolha (`list_model_candidates`/`spawn_agent`) e emendou I-06: a escolha runtime precisa ser filtrada, ranqueada, registrada e reproduzível. A pool e os profiles são do ADR-0007; falta o dono do pipeline de candidatos (M1–M8).

## Decisão

**Filtro duro (M2).** Candidato excluído se: tool não suportada, contexto insuficiente para a entrada estimada, `requires` não satisfeito (`CAPACITY_TAGS`), status não-`active`, quota indisponível no `quotaDomain`, conta não livre (ADR-0009) ou em cooldown, orçamento não cobre a reserva da cadeia (B9, ADR-0013). `need` valida contra `ROLE_TAGS` (`invalid_need`).

**Ranking (M6, M7, Q-07).** Adequação decide dentro do filtro; custo só desempata. Escalada refinada fica em v2 (M5).

**Snapshot e registro (A1).** `list_model_candidates` devolve candidatos + `snapshot_id` (TTL 5 min, invalidado por mudança de health/cooldown); `spawn_agent` grava a escolha no ledger — inclusive `default_rank` — e rejeita modelo fora do snapshot (`invalid_model_choice`, `candidate_set_changed`).

**Replay (M4, M8).** O `--resume` lê a escolha gravada na árvore de `agent` events; nada é recalculado (I-06). Identidade é composta `provider/id` (S-06, #123): `nvidia/x` e `openrouter/x` são modelos distintos; só o par exato é duplicado.

## Consequências

- Ganho: escolha runtime auditável e reproduzível; mesmas regras para spawn e handoff.
- Custo: S-09 (#126) implementa o pipeline; snapshot exige invalidação por health/cooldown.
- Invariantes afetadas: I-06 (emenda registrada em ADR-0008; aqui é o mecanismo), I-07 (identidade composta é a unidade de placement).

## Alternativas descartadas

- Custo como critério primário: viola Q-07 — adequação decide, custo desempata.
- LLM escolhe fora do snapshot: viola A3/ADR-0008.
- Recalcular escolhas no replay: quebra I-06 e a árvore gravada (M4).
