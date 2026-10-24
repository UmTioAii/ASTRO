# ADR-0006: artefato de handoff durável no ledger

- Status: aceita
- Data: 2026-10-24
- Issues: #75, #76, #77, #78
- Decisões relacionadas: D-02, D-09, D-10, D-11

## Contexto

O handoff é um envelope em memória (`src/tools/handoff.ts:32`): só `to` é validado, o payload é livre e nada é persistido antes da troca de agente. Queda entre a tool e o receptor perde o contexto; não há ack, id nem dedup. A retomada (F-06, F-22) e o blackboard (C4/#58) dependem de handoff confiável.

## Decisão

Handoff vira `HandoffArtifactV1`: artefato versionado com campos obrigatórios (`task`, `objective`, `decisions`, `constraints`, `next_steps`) e `handoff_id = sha256(run|from|to|taskHash|step)` determinístico, gravado no ledger append-only como `handoff.created` antes da troca de agente; o receptor confirma com `handoff.received`; pendências (`created` sem `received`) são retomáveis. Compactação é lossy por design, com recuperação por `source_refs` ao intervalo do ledger. Para viabilizar `source_refs` e CAS, entradas do ledger ganham `seq` monotônico opcional (aditivo; `schemaVersion` permanece 1, ADR-0002). Sem broker externo (D-02).

## Consequências

- Ganho: entrega garantida (I-19), trilha auditável (I-04), idempotência por `handoff_id`.
- Custo: handoff exige artefato válido (`ToolError` caso contrário); ledger ganha dois kinds de evento e `seq`.
- Invariantes afetadas: I-03 (payload sanitizado antes de gravar), I-04, I-18, I-19.

## Alternativas descartadas

- Envelope em memória (status quo): perde contexto em queda; sem ack; sem dedup.
- Broker externo (Redis/fila): viola D-02; o ledger append-only resolve durabilidade e CAS.
- Compactação sem perda: custo alto; `source_refs` recupera o detalhe da fonte.
