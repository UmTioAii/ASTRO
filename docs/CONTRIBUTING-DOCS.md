# Padrão de documentação

Objetivo: definir o formato de toda documentação publicada no repositório.

| Cobre | Não cobre |
|---|---|
| `README.md` e arquivos de `docs/` | Código-fonte e comentários |
| Formato, tamanho, referências e tom | Conteúdo técnico de cada documento |

## Regras

| # | Regra |
|---|---|
| 1 | Cada documento começa com uma linha de **objetivo** e uma tabela de **escopo** (o que cobre, o que não cobre). |
| 2 | Preferir tabela a prosa para comparações, IDs, variáveis e status. |
| 3 | Um conceito por seção. Nenhum parágrafo com mais de 4 linhas. |
| 4 | Referências internas sempre por ID: `#62`, `F-03`, `I-03`, `D-18`, `src/session.ts:22`. |
| 5 | Tamanho alvo: `README.md` até 200 linhas; cada doc de `docs/` até 150; roadmap em tabelas, sem texto corrido por item. |
| 6 | Sem emojis, sem marketing, sem "vamos", "nosso"; linguagem direta e impessoal. |
| 7 | Todo item de roadmap tem: ID, título, fase, status (`concluído` \| `em andamento` \| `planejado` \| `bloqueado`), issue (`#n`) e dependências. |
| 8 | Datas só quando houver evento verificável (merge, release). |
| 9 | `README.md` é escrito em inglês (decisão do dono: face pública do repositório); os demais docs de `docs/` seguem em português. |

## Verificação

- Antes de abrir o PR, conferir que a citação existe no ponto citado (caminho e linha).
- O que não foi verificado na fonte entra em seção "a verificar", não no corpo do documento como fato.
