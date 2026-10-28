# ADR-0013: budget com escopos, aviso, corte físico e reserva da cadeia

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-10, D-15, D-20, ADR-0007, ADR-0011

## Contexto

I-17 exige corte físico de custo; quota (`src/quota.ts`, por `quotaDomain`) e orçamento de projeto (`src/team.ts`) já existem. Falta a camada de budget (B1–B10) que unifica escopos, avisa, decide no esgotamento e reserva o custo da cadeia de fallback — sem segundo contador.

## Decisão

**Config (B1, D-CFG1).** `budget {scope: day|month|project|use-as-you-go, limitUsd, warnAt: 0.8, onExceed: "ask", hardCeilingUsd}`, cada campo com validação non-discard.

**Escopos sem segundo contador.** O gasto é sempre derivado do ledger. `day`/`month`/`project` usam janelas UTC (`project` = mês corrente, alinhado ao `team.projectBudgetUsd`); quota (`quotaDomain`) e team seguem como enforcement próprio. `project` cruza `team.projectBudgetUsd` e o menor vence; quota por domínio não entra no budget global (gasto global ≠ gasto do domínio) e `day` não tem limite USD em quota (quota diária é em tokens). Use-as-you-go (`limitUsd: null`) registra e exibe, nunca bloqueia (B2); preço ausente exibe "n/d", nunca zero (B6); leitura de assinatura vem com health/C6 (B7).

**Aviso e esgotamento (B3, B4).** Aviso em `warnAt` e no esgotamento; o prompt oferece três opções - continuar no mesmo esforço, baixar esforço (metade dos turnos restantes, ao menos um), parar - e a escolha vira `budget.exceeded_choice`. `onExceed: "stop"` para sem perguntar. Sem TTY, `ask` nunca bloqueia: grava checkpoint (L5, ADR-0014), para e registra `budget_exceeded_non_interactive`.

**Corte físico (B10, I-17).** `hardCeilingUsd` atingido → para independente de `onExceed` e registra `budget.ceiling_hit`. Com preço desconhecido e ceiling configurado, o run para com `unknown_price` (não dá para provar que está abaixo do teto).

**Reserva da cadeia (B9).** Antes de cada chamada, `budget.reserved` = Σ custo máximo do primário + fallbacks declarados; após, `budget.released` com `actual_cost`. A reserva casa por run (FIFO) e inclui fallbacks de profile; reserva maior que o limite/teto para antes da chamada. No `--resume`, `reserved` sem `released` conta como custo real (crash recovery). Sem preço na cadeia a reserva é 0 e o teto decide via `unknown_price`.

**Q-01 (L2).** `run.maxTurns: "unlimited"` exige `hardCeilingUsd` OU `limitUsd`; senão `loadConfig` falha com `unlimited_without_ceiling`.

**Ledger.** Este ADR é dono do kind `budget`: `reserved`, `released`, `exceeded_choice`, `ceiling_hit`, `budget_exceeded_non_interactive` (schema em #122).

## Consequências

- Ganho: corte físico auditável com uma única camada de custo sobre quota/team.
- Custo: S-15 (#132) implementa; config ganha a seção `budget`; display REPL fica em T1/T2.
- Invariantes afetadas: I-17 (dono do corte), I-19 (checkpoint antes de parar), I-03 (eventos sanitizados).

## Alternativas descartadas

- Segundo contador de budget: duplicaria quota.ts/team.ts com duas verdades.
- Corte só por quota de tokens: não cobre custo absoluto nem reserva da cadeia.
- `ask` bloqueante sem TTY: trava o modo não-interativo (golden §11.15).
