# ADR-0017: Bun empacotado como dependência opcional e launcher Node

- Status: aceita
- Data: 2026-10-29
- Issue: #219
- Decisões relacionadas: D-02, ADR-0001

## Contexto

O `bin` apontava para `dist/cli.js` com `#!/usr/bin/env bun`. Numa máquina com Node/npm e sem Bun
global, `npm i -g @umtioai/astro-harness@alpha` instala e cria o shim, mas `astro` falha com
`bun.exe não reconhecido`. `engines.bun` não é verificado pelo npm; o usuário precisava instalar o
Bun manualmente, o que quebra a promessa de instalação em um comando.

## Decisão

- `bin.astro` aponta para `dist/launcher.js`, um launcher Node (`#!/usr/bin/env node`).
- O Bun vai como `optionalDependencies` de plataforma, fixado em 1.4.2:
  `@oven/bun-<os>-<arch>` (com variantes `-musl` e `-android`). O npm instala só a compatível.
- O launcher resolve, nesta ordem: `ASTRO_BUN_PATH` → Bun que está executando (`bun add -g`) →
  binário da dependência de plataforma → `BUN_INSTALL/bin/bun` → `bun` no `PATH`.
- O launcher executa `bun dist/cli.js <args>` com `stdio` herdado e propaga código de saída/sinal.
- Sem argumentos em TTY, o CLI roda `tui`; sem TTY, imprime o help.

## Consequências

- `npm i -g` funciona sem Bun global, inclusive com `--ignore-scripts` (não há `postinstall`).
- O install não cria nem sobrescreve `bun`/`bunx` globais; o runtime fica aninhado no pacote.
- Custo: ~100 MB instalados e versão do Bun fixada pela release do ASTRO. Para trocar, use
  `ASTRO_BUN_PATH` ou atualize a dependência.
- `--omit=optional` remove o runtime: o launcher falha com instrução explícita.
- O caminho npm exige Node 18+ (só para o launcher); no caminho `bun add -g`, o próprio Bun o executa.
- Binários compilados (`bun build --compile`) continuam como alternativa futura para remover o Node.

## Alternativas descartadas

- Pacote meta `bun`: traz `postinstall` e cria shims globais `bun`/`bunx`, podendo sombrear o Bun do
  usuário.
- Downloader próprio no `postinstall`/primeira execução: rede e extração caseira, mais superfície de
  supply-chain e falha com `--ignore-scripts`/offline.
- Manter só a documentação “instale o Bun antes”: foi exatamente o defeito observado em campo.
