# ADR-0007: pool declarativa de modelos (profile → modelo)

- Status: aceita
- Data: 2026-10-24
- Issues: #82, #83, #84, #85, #86
- Decisões relacionadas: D-05, D-10, D-15, D-17, D-20

## Contexto

Agents referenciam modelos por `<provider>/<id>` direto. Uma camada de profiles nomeados (ex.: `coding-premium`, `cheap-explorer`) permite trocar o modelo de todos os agentes que o usam em um só lugar, sem editar cada agent; sem ela, C4 (#58) e C6 (#60) ficam acoplados a nomes crus de modelo. Preço e tags já vivem em `models[]` (D-05, D-10); duplicá-los por profile criaria três fontes de verdade (`models[]`, override global de C6, profile).

## Decisão

Profile é um alias declarativo: `modelPool[name] = { model: "<provider>/<id>", capabilities? (F-07, #81), fallback? (F-31, #86) }`. O campo `model` precisa existir em `models[]` e estar `active`. **Pricing é proibido no profile**: preço e tags são herdados de `models[]`; o único override continua sendo o `pricing` global de C6 (#60). `agents[*].profile?` e `agent.profile?` são opcionais e resolvem via Registry; sem profile, `agents[*].model` direto continua válido (migração suave; deprecação de `model` direto só em versão futura documentada). A LLM nunca escolhe modelo em runtime (I-06): o config escolhe o profile; a pool resolve. A seção `modelPool` é aditiva no config sob o semver global (sem versão aninhada). O ledger grava `profile` aditivo (`schemaVersion` permanece 1, ADR-0002) e o artefato de handoff carrega `from_profile?`/`to_profile?` opcionais (ADR-0006).

## Consequências

- Ganho: troca de modelo centralizada por profile; determinismo preservado; uma única fonte de preço.
- Custo: `validateConfig` ganha a seção `modelPool` (seção sem validador é descartada pela whitelist); CLI ganha `pool list`, `agents list`, `cost --by-agent` e `pool health`.
- Invariantes afetadas: I-01 (agent declara pool de modelos), I-06 (placement reproduzível), I-21 (capabilities de vocabulário fechado).

## Alternativas descartadas

- Pricing por profile: terceira fonte de preço; viola D-10 e o princípio de não duplicar `models[]`.
- LLM escolhe modelo em runtime: quebra I-06 e a auditabilidade da escolha.
- Substituir `agents[]`/`models[]`: `modelPool` estende a config existente, não substitui.
- Pool dinâmica autoajustável: YAGNI antes de C5 (#59) dar baseline.
