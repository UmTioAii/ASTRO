Skills reutilizáveis no formato `SKILL.md` (C1, #55): carregamento, instalação, CLI, invocação via `/<nome>` e permissões.

| Cobre | Não cobre |
|---|---|
| SKILL.md, skills CLI, `/nome`, permissões, sha256 | Parser YAML em si (`src/skills/loader.ts`), registro (`registry.ts`) |

## Raízes e fontes

| Fonte | Raiz | Como entra |
|---|---|---|
| `project` | `<cwd>/.astro/skills/` | Junto ao código, versionada no repo do usuário |
| `user` | `~/.astro/skills/` | Pessoal, vale para todos os projetos |

Cada skill vive em `<raiz>/<nome>/SKILL.md`; a chave é `fonte/nome` (`project/commit`). O nome puro só resolve quando é único; com ambas as fontes definidas, use a chave completa. Links (symlink/junction) de diretório ou de `SKILL.md` não são seguidos — skill fora da raiz não entra no contexto (I-03).

## Manifesto (frontmatter YAML)

```
---
name: commit            # ^[a-z0-9][a-z0-9_-]*$
description: Cria um commit
version: 1.0.0
permissions:
  tools: [read_file, run_command]   # precisa ser subconjunto da allowlist do agent (I-01)
  network: false
  filesystem: write                  # none | read | write
scripts:                             # opcional; rodam via run_command
  - name: check
    command: git status --short
---
Prompt da skill. Argumentos: $ARGUMENTS
```

- `name`, `description`, `version` e o prompt são obrigatórios; `permissions` tem defaults deny (`tools: []`, `network: false`, `filesystem: none`).
- O parser cobre mapas, listas em bloco (nos dois estilos de indentação), escalares e arrays inline — sem dependência de runtime. Limitações conhecidas: sem block scalar (`>`/`|`), chave duplicada usa a última, sem escapes de aspas, primeira chave de item com valor em bloco é rejeitada, sequência de sequências vira escalar, chave over-indentada em mapa pode sobrescrever campo (issue #112).

## CLI

```
bun src/cli.ts skills list                       # lista project/* e user/*
bun src/cli.ts skills show project/commit        # manifesto + prompt
bun src/cli.ts skills validate project/commit
bun src/cli.ts skills install <url|caminho>      # project por padrão; --user, --force
bun src/cli.ts skills remove <nome>              # --user para a raiz do usuário
bun src/cli.ts skills verify <nome>              # recalcula o sha256 do sidecar
```

`install` grava `<nome>/.sha256` (hash do texto sem BOM, o mesmo do `parseSkill`); `verify` recalcula pelo mesmo caminho. Instalação existente exige `--force`; origem que sobrepõe o destino é rejeitada por identidade física (`dev`/`ino`), imune a caixa, 8.3, `\\?\`, subst e junction. Skill escrita à mão (sem sidecar) falha o `verify`.

## Runtime

- Task começando com `/<nome>` (ex.: `/commit revisar o diff`) resolve na skill: o modelo recebe o prompt com `$ARGUMENTS` substituído e os scripts declarados anexados (executáveis via `run_command`, sujeitos a sandbox e timeout — F4-6). O conteúdo da task/prompt nunca é persistido; o audit grava só `taskHash` (I-04).
- Audit: `skill.loaded` {name, version, sha256, source} na invocação; `skill.installed` no install.
- Skill pedindo tool fora da allowlist do agent falha fechado antes de qualquer chamada (I-01). Nome inexistente ou ambíguo também falha o run com erro explícito.
- Teto de 1MB por SKILL.md lido/instalado.

## Exemplo

`examples/skills/commit/SKILL.md` — copie para `<projeto>/.astro/skills/commit/` e invoque com `/commit`.

## Referências

- #55 (C1), PR #111 (C1a), PR #113 (C1b); issue #112 (leniências do parser).
- I-01, I-03, I-04, I-11, I-14 em `docs/invariants.md`.
- Código: `src/skills/{types,loader,registry,installer,cli,executor}.ts`.
