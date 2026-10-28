# ADR-0010: repositório de sessão por session_id com subdiretório por agent_id

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-11, D-12, ADR-0006, ADR-0008, ADR-0009

## Contexto

T1 (#62) persiste a conversa do REPL num JSON plano `.astro/sessions/<ts>.json`. O REPL é o escopo, mas a mesma base precisa acomodar subagentes (ADR-0008) e a migração para SQLite da T4 (#65). Há ainda a colisão D-12: o repo define "sessão single-agent com loop de steps" (`docs/decisions.md:24`) e a trilha de planejamento usa "D-12" para a swap ladder.

## Decisão

**Layout (PS-1, PS-3).** O store vive em `.astro/sessions/<session_id>/<agent_id>/`: `messages.jsonl` (histórico sanitizado, PS-2) e `checkpoint.json` (L5, ADR-0014), ambos com schema versionado. T1 entrega o subdiretório do agente único (`planner`, Q-03); o subdiretório por `agent_id` prepara o multi-agent sem custo extra. T4 migra JSON→SQLite (`bun:sqlite`) preservando o layout lógico.

**Artigo funcional, não fonte de verdade.** O arquivo de sessão é artefato funcional local sanitizado na escrita (I-03); D-11 (só `taskHash`) segue valendo para audit/ledger. A árvore de agentes, placement e escolhas NÃO vivem no store: o ledger é a fonte (`agent` events, M4/#131); árvore quebrada → `replay_incomplete`, nunca resume parcial silencioso.

**Q-13 e a colisão D-12.** O D-12 do repo permanece: a sessão é um loop single-agent determinístico. A swap ladder da trilha mapeia para a cadeia de handoff (ADR-0006, F-23/F-24): troca de agente é handoff para outro agent declarado, com CAS e registro no ledger — nunca mutação do loop em execução. REPL T1 fica single-agent.

## Consequências

- Ganho: T1/T4 desbloqueadas com um único modelo de dados; colisão D-12 resolvida sem quebrar o determinismo.
- Custo: T1 muda do `<ts>.json` plano para o layout por `session_id`; resume depende do ledger intacto.
- Invariantes afetadas: I-03 (sanitize na escrita), I-19 (resume determinístico via ledger, não via store).

## Alternativas descartadas

- Manter `<ts>.json` plano: sem espaço para o multi-agent de ADR-0008; colisão de nomes por timestamp.
- Swap ladder in-place no loop: quebra o determinismo auditável e o replay (M4).
- Store como fonte da árvore de agentes: duplicaria o ledger (D-10) com duas verdades.
