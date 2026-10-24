# ADR-0006: artefato de handoff durável no ledger

- Status: aceita
- Data: 2026-10-24
- Issues: #75, #76, #77, #78
- Decisões relacionadas: D-02, D-09, D-10, D-11

## Contexto

O handoff é um envelope em memória (`src/tools/handoff.ts:32`): só `to` é validado, o payload é livre e nada é persistido antes da troca de agente. Queda entre a tool e o receptor perde o contexto; não há ack, id nem dedup. A retomada (F-06, F-22) e o blackboard (C4/#58) dependem de handoff confiável.

## Decisão

Handoff vira `HandoffArtifactV1`: artefato versionado com campos obrigatórios (`task`, `objective`, `decisions`, `constraints`, `next_steps`) e `handoff_id = sha256(run|from|to|taskHash|source_step)` determinístico, com `taskHash = sha256(task + "|" + objective)`. Mudanças em `decisions`/`constraints`/`next_steps` não alteram o id. O artefato carrega `version` (do schema do artefato, distinta do `schemaVersion` do ledger, ADR-0002), `source_step` (base do verifier, F-26) e `budget_spent` (leitura do ledger no momento do handoff, nunca contador paralelo). Opcionalmente carrega `from_profile?`/`to_profile?` quando emissor/receptor usam a pool (F-27, ADR-0007).

Gravado no ledger append-only como `handoff.created` antes da troca de agente; ciclo de vida: `handoff.received`, `handoff.failed`, `handoff.ack_timeout` — espelhados no audit sanitizados (I-04). Pendências (`created` sem `received`) são retomáveis, filtradas por run e pelo ledger do cwd corrente (`paths.ledger`).

Compactação é lossy por design, com recuperação por `source_refs = {ledger_id, seq_start, seq_end}`; entradas do ledger ganham `seq` monotônico opcional (aditivo; `schemaVersion` permanece 1, ADR-0002). Erros de handoff usam códigos estáveis — `handoff_target_not_found`, `handoff_mismatch`, `handoff_artifact_mismatch` são não retentáveis; `handoff_ack_timeout` é retriable — mapeados à taxonomia fixa de D-18, sem classe nova. Sem broker externo (D-02).

## Consequências

- Ganho: entrega garantida (I-19), trilha auditável (I-04), idempotência por `handoff_id`.
- Custo: handoff exige artefato válido (`ToolError` com código estável caso contrário); ledger ganha quatro kinds de evento e `seq`.
- Invariantes afetadas: I-03 (payload sanitizado antes de gravar), I-04, I-18, I-19.

## Alternativas descartadas

- Envelope em memória (status quo): perde contexto em queda; sem ack; sem dedup.
- Broker externo (Redis/fila): viola D-02; o ledger append-only resolve durabilidade e CAS.
- Compactação sem perda: custo alto; `source_refs` recupera o detalhe da fonte.
