# Mapa da documentação

Objetivo: apontar o documento certo para cada tarefa.

| Cobre | Não cobre |
|---|---|
| Índice dos documentos de `docs/` | Conteúdo dos próprios documentos |

| Arquivo | Quando ler | Linhas |
|---|---|---|
| `AGENTS.md` | Sempre, no início de qualquer sessão | ~110 |
| `docs/CONTRIBUTING-DOCS.md` | Antes de escrever ou revisar qualquer documento | ~25 |
| `docs/workflow.md` | Ao abrir branch, commit ou PR | ~90 |
| `docs/review-checklist.md` | Ao revisar um PR | ~50 |
| `docs/invariants.md` | Ao tocar em segredo, tool, caminho, custo, aprovação ou auditoria | ~50 |
| `docs/decisions.md` | Ao precisar do motivo de uma escolha (D-xx) | ~100 |
| `docs/adr/` | Decisão arquitetural nova ou revisão de uma antiga | 1 por arquivo |
| `docs/roadmap.md` | Histórico das fases concluídas (F0–F7) | ~70 |
| `docs/roadmap-complementar.md` | Itens planejados das camadas 0–3 (F-xx, T, C, P) | ~120 |
| `docs/providers.md` | Ao construir provider, validar credencial ou usar os SDKs | ~90 |

Referências usadas nos documentos:

- `D-xx`: decisão, em `docs/decisions.md`.
- `I-xx`: invariante, em `docs/invariants.md`.
- `ADR-NNNN`: decisão arquitetural, em `docs/adr/`.
- `#n`: issue ou PR no GitHub.
- `F0`–`F7`: fase concluída, em `docs/roadmap.md`.
- `F-xx`: item da Camada 0, em `docs/roadmap-complementar.md`.
- `T1`–`T4`, `C1`–`C7`, `P-01`–`P-04`: itens das camadas 1–3, em `docs/roadmap-complementar.md`.
