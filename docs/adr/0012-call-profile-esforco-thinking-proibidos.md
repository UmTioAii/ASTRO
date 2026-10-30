# ADR-0012: call profile com escala de esforço, thinking e proibidos

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-15, ADR-0007, ADR-0011

## Contexto

Providers divergem em parâmetros de esforço e raciocínio (Anthropic `thinking`, OpenAI `reasoning.effort`, DeepSeek, Kimi — E6 exige reverificação por provider antes de codar). O harness precisa de uma camada uniforme (`lvl` 0–4) sobre a pool (ADR-0007) sem persistir texto de raciocínio (I-03) e sem que o modelo injete parâmetros (I-01).

## Decisão

**Schema por modelo (D-CFG1).** `call.thinking {mode: toggle|always|adaptive|none, param, on, off}`, `call.effort {param, map {"0".."4"}}`, `call.forbidden: string[]` — cada campo com validação non-discard no padrão de `validateNamedAgent`.

**Escala e automação (E1–E5).** `lvl` 0 `low` … 4 `ultra` resolve pelo effort map (E1); thinking é separado do esforço (E2); valor fixado pelo usuário nunca é sobrescrito pelo caminho automático (E3); subir 1–2 níveis é automático, 3+ pede aprovação (E4); descer é sempre automático (E5). Aprovação de E4 é de parâmetro, não troca de identidade (I-08 intocada).

**Proibidos e raciocínio (E7, E8, Q-08).** Parâmetro em `forbidden` é removido antes do envio e gravado como `param.stripped`; o `usage` do ledger ganha `lvl`, `effort`, `thinking` validados na escrita. Texto de raciocínio devolvido pelo provider NÃO é persistido (Q-08 default: só a contagem de tokens entra no usage).

**Parâmetro não verificado (E9).** Provider sem parâmetro verificado (ex.: GLM via NIM) não é hardcoded: exige config explícita e limitação documentada.

**E6 na implementação.** A reverificação dos valores oficiais por provider (Anthropic/OpenAI/DeepSeek/Kimi) acontece antes de codar, em S-08 (#125); divergência registrada, valor oficial vigente vence.

**Implementação (S-08, #125).** `src/call-profile.ts` resolve `lvl`/effort/thinking e remove `forbidden` antes do envio; `models[].call` é validado no startup e aplicado pelos providers builtin. O `usage` grava `lvl`, `effort`, `thinking` e `param.stripped` como `[{name, reason}]` (ledger schema v3). A tabela E6 verificada fica em `docs/providers.md`; provider não verificado (GLM via NIM) exige config explícita.

## Consequências

- Ganho: superfície uniforme entre providers; auditoria do que foi enviado e do que foi proibido.
- Custo: S-08 (#125) implementa; config ganha a seção `call` por modelo.
- Invariantes afetadas: I-03 (raciocínio não persistido), I-01 (nada fora do schema é enviado); `param.stripped` e `lvl`/`effort`/`thinking` vivem no `usage` do ledger (#122, E7), não em evento de audit.

## Alternativas descartadas

- Persistir texto de raciocínio: viola I-03 (Q-08 registra o default contrário).
- Esforço único global: ignora a divergência de providers que E6 mede.
- Thinking acoplado ao esforço: E2 exige controle independente.
