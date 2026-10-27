# CI (GitHub Actions)

Resumo: jobs que rodam em todo PR, pré-requisitos de runner e equivalente local; CI verde é pré-condição de merge (`docs/workflow.md` §6).

| Cobre | Não cobre |
|---|---|
| Jobs, pré-requisitos de runner, equivalente local, política de merge | Billing e segredos do repositório no GitHub |

## Jobs (`.github/workflows/ci.yml`)

| Job | Runner | O que faz | Equivalente local |
|---|---|---|---|
| `test` | ubuntu-latest + windows-latest | `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` | os mesmos comandos |
| `eval` | ubuntu-latest | `bun src/cli.ts eval --threshold 0.85 --report eval-report.json` (mock) | idem |
| `secrets` | ubuntu-latest | gitleaks no histórico | — |

A matriz `test` roda nos dois SOs de propósito: há regressões específicas de win32 (paths, quirk de stdout do Bun) e de Linux (POSIX, Docker).

## Pré-requisitos e comportamento condicional

- **Docker**: só é usado quando `docker info` responde com engine **Linux** (`OSType=linux`). Windows containers e ausência de daemon → recusa clara do sandbox, sem downgrade. Testes de sandbox têm timeout de 60s (pull + quatro execuções).
- **LSP**: usa `typescript/unstable/async` (streams), compatível com Bun no Linux e no Windows. O canal sync dependia de `stdout._handle.fd`, indisponível no Bun/POSIX (#140).
- **Skill**: teste de `run_command` não depende do `PATH` do host; o `env` do run é o ambiente do filho.

## Política de merge

- PR só entra com `test` verde nos **dois** sistemas, `eval` e `secrets` verdes, mais `Revisão: APPROVE` (`docs/workflow.md` §6).
- Não usar `--admin` para contornar check vermelho. Exceção por causa externa (billing, runner) é registrada no PR com justificativa e issue de correção.
- Falha intermitente: reexecutar o job; se repetir, abrir issue com o link do run.

## Referências

#140 (CI verde), `.github/workflows/ci.yml`, `docs/workflow.md` §6, `docs/review-checklist.md`.
