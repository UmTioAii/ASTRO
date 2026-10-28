# ADR-0014: loop de segmento com checkpoint e guarda de não-progresso

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-12, ADR-0010, ADR-0013

## Contexto

`maxSteps` existe (`src/session.ts`); F-06 (S-10) dá cancelamento e F-22 (S-14) resume determinístico. Falta o loop de segmento com presets, checkpoint e guarda de não-progresso (L1–L7) para runs longos sob budget.

## Decisão

**Presets (L1).** Config `run {maxTurns: 100 | 500 | "unlimited", checkpointAt: 0.8, noProgressSegments: 3, judge: "off"}`; `"unlimited"` segue a exigência de teto de ADR-0013 (L2, Q-01).

**Turno (L3).** Um turno = uma chamada de modelo + as tool calls que ela pede; completion sem tool calls encerra o loop (semântica atual de `maxSteps` preservada).

**Checkpoint (L5).** A 80% do limite de turnos OU do orçamento restante, grava `{summary, changed files, next step}` sanitizado (I-03) no store do ADR-0010 (PS-2). Bater o limite para em estado seguro (I-19, via S-10); "continue" retoma; subir turnos é grátis, subir orçamento pede aprovação.

**Não-progresso (L6).** Sinais por segmento: hash dos arquivos tocados sob `cwd`, testes passando/falhando, tamanho do histórico; 3 segmentos sem mudança → pausa e pergunta.

**Judge (L4).** Permanece `off` por default; `on`/`auto` ficam documentados sem implementação (v2, guarda-chuva #138).

**Paradas físicas (L7).** Loop `unlimited` para por: conclusão, teto físico (`ceiling_hit`, ADR-0013) ou não-progresso — nunca roda sem parada física (golden §11.8).

## Consequências

- Ganho: runs longos supervisionados, com estado seguro e retomável; sem loop infinito sem corte.
- Custo: S-18 (#135) implementa; apresentação no REPL/TUI fica em T1/T2.
- Invariantes afetadas: I-19 (estado seguro e retomável), I-03 (checkpoint sanitizado).

## Alternativas descartadas

- Sem checkpoint: trabalho longo perdido no esgotamento do limite.
- Judge `on` por default: custo extra e não determinismo — v2.
- Parar apenas em `maxTurns`: deixa o loop sem corte quando não há progresso.
