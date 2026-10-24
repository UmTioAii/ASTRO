# Fluxo de trabalho

Resumo obrigatório em `AGENTS.md`. Este arquivo tem o detalhe.

## 1. Issue

- Toda mudança nasce de uma issue, pelo template `tarefa`. Exceção: correção de typo em doc.
- A issue tem: objetivo, critério de aceite testável, invariantes afetados (`I-xx`) e fase (`F3`, etc.).
- Estado do projeto vive em issues e milestones. Consulta: `gh issue list --label "fase:F3" --state open`.

## 2. Branch

- `main` é protegida. Ninguém faz commit direto nela.
- Nome: `<tipo>/<n>-<slug>`. Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`.
- Uma branch para uma issue. Um PR para uma branch.
- Quem escreve código usa worktree (D-13):
  `git worktree add .worktrees/feat-14-pool -b feat/14-pool-placement origin/main`
- Branch antiga: `git fetch && git rebase origin/main` antes de continuar.

## 3. Commits

- Formato: `tipo: resumo no imperativo, até 72 caracteres`.
- Corpo opcional. Rodapé obrigatório: `Refs #14`.
- RED e GREEN em commits separados (`test:` antes de `feat:`). Facilita a evidência TDD.
- Nunca commitar: `.env*`, `astro.config.json` real, `.astro/`, arquivos de credencial, saída de teste com segredo.

## 4. Pull request

- Título em formato de commit, por exemplo `feat: placement com triplet provider/model/credential`.
- Corpo pelo template. Termina com `Closes #14`, o que fecha a issue no merge.
- Tamanho: alvo de até 200 linhas alteradas; teto de 400. Acima disso, dividir em PRs encadeados (schema → adaptador → CLI). Exceção justificada no corpo.
- Abra como draft enquanto trabalha. Marque "Ready for review" só com CI verde e checklist preenchido.
- Um PR por issue. Não reaproveitar PR para outra issue.

## 5. Revisão

- Obrigatória antes do merge. Checklist em `docs/review-checklist.md`.
- Revisor não é o autor: subagente ou sessão nova, recebendo o diff e o checklist, sem o raciocínio que produziu o código.
- Veredito como comentário no PR, na primeira linha: `Revisão: APPROVE` ou `Revisão: REQUEST_CHANGES`, seguido de itens numerados.
- Item bloqueante exige `arquivo:linha` e um cenário concreto de falha.
- Achado de segurança bloqueia sempre.
- Após correção, a nova revisão cobre só o commit novo.

## 6. Merge

- Pré-condições: CI verde, `Revisão: APPROVE` no PR, docs atualizados, checklist marcado.
- Squash merge. Título do PR vira a mensagem, com `(#PR)` no fim.
- Branch apagada automaticamente após o merge (configuração do repo).

## 7. Depois do merge

- Nenhum passo manual se `Closes #n` estiver no corpo.
- Se a issue tinha um ADR pendente, o ADR entra no mesmo PR, não depois.

## 8. Setup do GitHub (uma vez)

Labels:

```bash
for l in "tipo:feat" "tipo:fix" "tipo:docs" "tipo:test" "tipo:refactor" "tipo:chore" "tipo:ci" \
         "fase:F0" "fase:F1" "fase:F2" "fase:F3" "fase:F4" "fase:F5" "fase:F6" "fase:F7" \
         "risco:seguranca" "bloqueado"; do
  gh label create "$l" --force
done
```

Repositório: apagar branch após merge e permitir só squash.

```bash
gh api -X PATCH repos/UmTioAii/ASTRO \
  -f delete_branch_on_merge=true \
  -f allow_squash_merge=true -f allow_merge_commit=false -f allow_rebase_merge=false
```

Proteção da `main` (arquivo `.github/branch-protection.json`):

```bash
gh api -X PUT repos/UmTioAii/ASTRO/branches/main/protection --input .github/branch-protection.json
```

Observação: o GitHub não deixa o autor aprovar o próprio PR. Com conta solo, `required_approving_review_count` fica em `0`, e a revisão obrigatória é garantida pelo veredito no PR (`Revisão: APPROVE`) e pela regra deste documento. Quando houver um segundo revisor humano, suba para `1`.
