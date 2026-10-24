# Roadmap — fases concluídas

Objetivo: registro verificável das fases F0–F7, com issue, PR e commit de fechamento.

| Cobre | Não cobre |
|---|---|
| F0–F7 (histórico, status `concluído`) | Itens planejados (em `docs/roadmap-complementar.md`) |

## F0 — Fundação

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F0 | Repo público, CI, estrutura `src/`+`tests/` | — | concluído | da85bad |
| F0 | Nome do projeto | — | concluído | 37ff8b6 |

## F1 — Providers e config

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F1 | Config validada, tags e defaults | — | concluído | c8973ed |
| F1 | Registry de modelos com status | — | concluído | d320657 |
| F1 | Provider openai-compat | — | concluído | 1b18e27 |
| F1 | Redação de segredo em erro de provider | — | concluído | 81311c9 |
| F1 | Provider codex-oauth | — | concluído | f4ffb5e |

## F2 — Single agent

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F2 | Auditoria append-only sanitizada | — | concluído | 7cd6e6a |
| F2 | Ledger de uso com custo | — | concluído | 375c683 |
| F2 | Tools com confinamento e timeout | — | concluído | 47f0f17 |
| F2 | Sessão com loop de tools | — | concluído | 50f34ef |
| F2 | CLI run ponta a ponta | — | concluído | e2df3c9 |
| F2 | Redação de metadata de segredo | — | concluído | 55ffaff |
| F2 | Golden task da F2 | — | concluído | d94ba5b |
| F2 | Núcleo F2 integrado | — | concluído | 566bc7f |

## F3 — Multi-agent

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F3-1 | Agent registry na config | #1 | concluído | PR #28 (7bc751b) |
| F3-2 | Handoff protocol entre agents | #2 | concluído | PR #29 (e4604df) |
| F3-3 | Ledger/audit por agent no mesmo run | #3 | concluído | PR #30 (08681f8) |
| F3-4 | Orquestrador com maxSteps duplo | #4 | concluído | PR #31 (2c7b193) |
| F3-5 | Isolamento de tools por agent | #5 | concluído | PR #32 (3cbfd5d) |

## F4 — Tooling

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F4-1 | grep | #6 | concluído | PR #33 (9b4cb9e) |
| F4-2 | list_dir | #7 | concluído | PR #34 (1c3bf2c) |
| F4-3 | edit (diff com backup e rollback) | #8 | concluído | PR #35 (4470a29) |
| F4-4 | lsp (análise via compilador nativo TS) | #9 | concluído | PR #36 (12f90df) |
| F4-5 | pipeline (composição com allowlist) | #10 | concluído | PR #37 (c23cedb) |
| F4-6 | sandbox para run_command | #11 | concluído | PR #38 (173f8f4) |

## F5 — Eval e qualidade

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F5-1 | Golden dataset (50 cases) | #12 | concluído | PR #39 (c65be26) |
| F5-2 | Auto-eval harness | #13 | concluído | PR #40 (b8d0c81) |
| F5-3 | Regression gate no CI | #14 | concluído | PR #41 (652ec4d) |
| F5-4 | Benchmark de providers | #15 | concluído | PR #42 (acd6861) |
| F5-5 | Telemetria opt-in | #16 | concluído | PR #43 (8099838) |

## F6 — Produção

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F6-1 | /metrics Prometheus | #17 | concluído | PR #44 (f63344a) |
| F6-2 | Tracing OTLP/HTTP | #18 | concluído | PR #45 (4370137) |
| F6-3 | Rate-limit e quota por domínio | #19 | concluído | PR #46 (c4b3605) |
| F6-4 | Completion cache (SQLite) | #20 | concluído | PR #47 (7d53ca6) |
| F6-5 | Replay | #21 | concluído | PR #48 (c531101) |
| F6-6 | Health check | #22 | concluído | PR #49 (75e0a7a) |

## F7 — Ecossistema

| ID | Entrega | Issue | Status | Fechamento |
|---|---|---|---|---|
| F7-1 | Plugin system | #23 | concluído | PR #50 (03dc027) |
| F7-2 | Provider SDK | #24 | concluído | PR #51 (dc28b7e) |
| F7-3 | Tool SDK | #25 | concluído | PR #52 (e5c8482) |
| F7-4 | Config sharing (push/pull) | #26 | concluído | PR #53 (8734469) |
| F7-5 | Team features (budget, quota, webhook) | #27 | concluído | PR #54 (6fc1cc9) |
