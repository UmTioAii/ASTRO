# ADR-0002: schemaVersion inteiro do ledger

- Status: aceita
- Data: 2026-10-24
- Issue: #73
- Decisões relacionadas: D-10

## Contexto

O ledger JSONL é a fonte de retomada (#F-06, F-22) e idempotência (F-03). O formato ganha campos ao longo da Camada 0; sem versionamento, um leitor não distingue entrada antiga de nova. A config da CLI já tem `version` semver (`src/config.ts`), mas versiona arquivo de configuração, não dado persistido.

## Decisão

O ledger carrega `schemaVersion` inteiro monotônico a partir de 1 (`LEDGER_SCHEMA_VERSION`), gravado automaticamente em toda entrada; semver continua só na config. Mudança incompatível de formato incrementa o inteiro; entrada sem `schemaVersion` é lida como versão 0.

## Consequências

- Ganho: retomada e migração determinísticas; leitor detecta versão futura que não conhece.
- Custo: todo leitor valida o campo antes de consumir o arquivo.
- Invariantes afetadas: I-04 (ledger rastreável), I-19 (estado de execução como checkpoint).

## Alternativas descartadas

- Semver no ledger: dado persistido não tem API; o ponto é detectar incompatibilidade, não comunicar compatibilidade.
- Um arquivo por versão: multiplica arquivos e complica a retomada de um run.
