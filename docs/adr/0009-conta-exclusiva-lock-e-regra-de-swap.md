# ADR-0009: conta exclusiva por agente ativo, lock em ledger, crash recovery e regra de swap

- Status: aceita
- Data: 2026-10-27
- Issue: #118
- Decisões relacionadas: D-10, D-14, D-20

## Contexto

A unidade de placement é `(provider, modelo, credencial)` e a quota agrega por conta/org (I-07): dois agentes ativos sobre a mesma credencial disputam o mesmo limite e tornam o consumo imprevisível. Um crash do processo deixaria o agente "ativo" para sempre, com a credencial cativa. Toda troca de identidade exige aprovação humana (I-08), mas o fallback declarado (F-31, #86) precisa de uma regra para quando a troca pode ser automática.

## Decisão

**Contas (A4, Q-04).** Cada agente ativo (orchestrator incluído) retém uma credencial com exclusividade; nenhuma credencial atende dois agentes simultâneos. Uma sessão Codex não serve dois agentes — exclusiva como as contas NIM.

**Lock em ledger (PS-5).** O lock é o par de eventos de ledger do tipo `agent` (kind de #122): `created` ao adquirir, `destroyed` ao liberar, ligados por `agent_id`/`session_id`. Credencial está presa se existe `agent.created` sem `agent.destroyed` correspondente. Sem arquivo de lock separado: o ledger append-only (D-10) é a única fonte de verdade. O lock não mexe em quota (`src/quota.ts` intocado): lock é exclusividade de uso; consumo segue agregado por `quotaDomain` (D-20, I-07).

**Crash recovery (A4).** No `--resume` (superfície planejada, F-22; implementação em S-07, #124), todo agente com `created` e sem `destroyed` recebe `destroyed` com `reason: "crash_recovered"`; a credencial volta a ficar livre.

**Regra de swap (A6, A7, Q-11).** Escolhida a regra (a): o gate de aprovação F-19 (#129, S-12) é pré-requisito do swap automático. Até lá, o fallback declarado em `modelPool.fallback` (F-31) só troca com aprovação humana em runtime (I-08); a cadeia atravessada é exatamente a declarada (S-13, #130), dentro da classe de equivalência (I-22). Triggers (A6): esgotados os retries da classe de erro (D-14) na conta atual, ou classe mapeada para troca; o destino (A7) exige conta livre sob a mesma exclusividade de A4. Nota de transição: a cadeia F-31 existente (`src/provider/profile-fallback-provider.ts`) hoje troca sem gate; fica não-conforme com esta regra até S-13 (#130) aplicá-la.

ADR-0008 (S-02a, #119) referencia A4; a posse do assunto é deste ADR. Implementação: S-07 (#124) para lock, S-12 (#129) para o gate, S-13 (#130) para a cadeia.

## Consequências

- Ganho: exclusividade auditável em uma única fonte de verdade; recuperação de crash determinística; nenhum swap silencioso.
- Custo: `--resume` ganha varredura de órfãos; S-07 (#124) implementa aquisição/liberação; a cadeia F-31 existente fica não-conforme até S-12 (#129) + S-13 (#130).
- Invariantes afetadas: I-07 (placement e quota por conta), I-08 (toda troca aprovada), I-22 (substituição só na classe declarada).

## Alternativas descartadas

- Regra (b), aprovação de config basta para o swap automático: dispensaria o gate de runtime para a troca da cadeia (trocas ad hoc seguiriam em S-12); descartada pelo default da trilha (Q-11 = (a)).
- Lock em arquivo separado por credencial: segunda fonte de verdade; não sobrevive a crash sem limpeza manual.
- Lock consumindo/liberando quota: mistura exclusividade com consumo; `src/quota.ts` permanece intocado.
- Sessão Codex compartilhada entre dois agentes (Q-04): quebra a exclusividade de A4 e a agregação de quota por conta.
