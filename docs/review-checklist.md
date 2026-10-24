# Checklist de revisão de PR

Use com o diff do PR e a issue vinculada. Não use o raciocínio do autor como fonte.

## Bloqueantes (qualquer falha = REQUEST_CHANGES)

- [ ] Segredo: nenhum valor de chave, token ou credencial no diff, em teste, log, audit, ledger ou mensagem de erro (I-03).
- [ ] Allowlist: tool nova ou alterada só executa se estiver na allowlist; nada executa por padrão (I-01).
- [ ] Caminho: leitura e escrita de arquivo passam por confinamento; teste cobre `..` e symlink (I-11).
- [ ] Prompt do usuário não aparece em audit nem em ledger; só `taskHash`.
- [ ] Teste RED existe e foi registrado no PR, ou a justificativa de ausência está no corpo.
- [ ] `bun test` e `bun run typecheck` passam no CI.
- [ ] Issue vinculada com `Closes #n` e critério de aceite atendido.

## Não bloqueantes (viram sugestão numerada)

- [ ] Nome de função e tipo descreve o que faz.
- [ ] Erro novo é classificado segundo o taxonomia D-18, não com `Error` genérico.
- [ ] Caso de borda sem teste (retry com `Retry-After`, `costUsd: null`, timeout, arquivo grande).
- [ ] `as` em vez de checagem de tipo.
- [ ] Dependência nova: está fixada em versão exata e tem ADR.

## Documentação

- [ ] Doc afetado atualizado no mesmo PR.
- [ ] Novo arquivo em `docs/` está em `docs/INDEX.md`.
- [ ] Nenhuma informação duplicada de outro arquivo; linkada em vez de copiada.
- [ ] Referências por ID (`D-xx`, `I-xx`, `#n`), não por linha.

## Tamanho

- [ ] Diff até 400 linhas, ou exceção justificada no corpo.
- [ ] Um assunto por PR.

## Formato do veredito

```
Revisão: REQUEST_CHANGES

1. [bloqueante] src/tools/run-command.ts:42 — `env` herda `process.env` inteiro; com `~/.codex/auth.json` o conteúdo é legível via `cat`. Cenário: modelo chama run_command com "cat ~/.codex/auth.json". Correção: env sanitizado.
2. [sugestão] tests/session.test.ts — falta caso de maxSteps = 0.
```

Sem item com cenário concreto, o veredito é `APPROVE` com sugestões.
