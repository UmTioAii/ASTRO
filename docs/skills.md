Skills reutilizáveis no formato `SKILL.md` (C1, #55): carregamento, instalação, CLI, invocação via `/<nome>` e permissões.

| Cobre | Não cobre |
|---|---|
| SKILL.md, skills CLI, `/nome`, permissões, sha256 | Parser YAML em si (`src/skills/loader.ts`), registro (`registry.ts`) |

## Raízes, manifesto e runtime

- Raízes: `project` = `<cwd>/.astro/skills/`, `user` = `~/.astro/skills/`. Cada skill é `<raiz>/<nome>/SKILL.md`, com chave `fonte/nome` (`project/commit`); nome puro só resolve quando único. Links (symlink/junction) de diretório ou de `SKILL.md` não são seguidos (I-03).
- Frontmatter: `name` (`^[a-z0-9][a-z0-9_-]*$`), `description`, `version` e o prompt (após `---`) obrigatórios; `permissions` com defaults deny (`tools: []`, `network: false`, `filesystem: none`); `scripts` opcional. Teto de 1MB por SKILL.md na leitura e na instalação; download remoto corta o stream ao passar do teto (não bufferiza o corpo inteiro) e a origem passa por `outboundUrlProblem` (#256).
- Parser: mapas, listas em bloco (ambos estilos), escalares e arrays inline, sem dependência. Limitações: sem block scalar/escapes; chave duplicada usa a última; primeira chave de item com valor em bloco é rejeitada; sequência de sequências vira escalar; chave over-indentada em mapa pode sobrescrever campo (#112); nomes reservados do Windows (`con`, `nul`) passam no regex; fonte-arquivo dentro do destino não toca a guarda de sobreposição.

```
---
name: commit
description: Cria um commit
version: 1.0.0
permissions:
  tools: [read_file, run_command]   # ⊆ allowlist do agent (I-01)
  network: false
  filesystem: write                  # none | read | write
scripts:
  - name: status
    command: git status --short      # executável via run_command (sandbox/timeout, F4-6)
---
Prompt da skill. Argumentos: $ARGUMENTS
```

## CLI e runtime

- CLI (`bun src/cli.ts skills <subcomando> [--user] [--force]`): `list`, `show <nome>`, `validate <nome>`, `install <url|caminho>`, `remove <nome>`, `verify <nome>`. Install grava `<nome>/.sha256` (hash do texto sem BOM, recalculado igual no `verify`); existente exige `--force`; sobreposição origem×destino é rejeitada por identidade física (imune a caixa, 8.3, `\\?\`, subst, junction). Skill manual (sem sidecar) falha o `verify`. Install de pacote (diretório) rejeita qualquer link simbólico/junction em vez de copiar o alvo (#256). No load, skill com sidecar presente e sha256 divergente é ignorada com warn; skill manual sem sidecar carrega (#256).
- Runtime: task `/<nome> args` (ou `/project/<nome>`) resolve na skill — o modelo recebe o prompt com `$ARGUMENTS` substituído e os scripts declarados anexados. Tools da skill fora da allowlist do agent falham o run antes de qualquer chamada (I-01); skill inexistente/ambígua idem. Audit: `skill.loaded` {name, version, sha256, source} na invocação, `skill.installed` no install; task/prompt nunca são persistidos (I-04).

## Exemplo e referências

- `examples/skills/commit/SKILL.md` — copie para `<projeto>/.astro/skills/commit/` e invoque `/commit`.
- #55 (C1), PR #111 (C1a), PR #113 (C1b), issue #112; I-01/I-03/I-04/I-11/I-14 em `docs/invariants.md`; código em `src/skills/`.
