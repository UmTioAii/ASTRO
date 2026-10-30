# ADR-0018: Bun como dependência npm única (`bun`) no lugar das opcionais de plataforma

- Status: aceita
- Data: 2026-10-30
- Issue: #219 (emenda ao ADR-0017; entrou no PR #245)
- Decisões relacionadas: D-02, ADR-0001, ADR-0017

## Contexto

O ADR-0017 empacotou o Bun em `optionalDependencies` de plataforma (`@oven/bun-<os>-<arch>`) e o launcher descobria o binário por uma lista própria. Manter a lista no `package.json` do ASTRO duplica a matriz do pacote oficial e exige atualização manual a cada release do Bun. O pacote npm `bun` já publica exatamente essa matriz (mais `postinstall` para materializar o binário) e declara `bin.bun`/`bin.bunx`.

## Decisão

- O ASTRO depende de **`bun@1.4.2`** em `dependencies` (não `optionalDependencies`), mantendo a versão pinada pela release.
- O launcher resolve, nesta ordem: `ASTRO_BUN_PATH` → Bun que está executando → binário de `bun/package.json` em `node_modules` → `bun` no `PATH`.
- O `postinstall` do pacote `bun` roda no install para materializar o binário; `--ignore-scripts` deixa o passo sem efeito e o launcher cai no `PATH`/`ASTRO_BUN_PATH`.
- Instalar o ASTRO **não** cria nem sombreia `bun`/`bunx` globais: o `bin` de uma dependência aninhada não é linkado globalmente pelo npm. A objeção do ADR-0017 vale para `npm i -g bun`, não para este uso.
- `--omit=optional` continua removendo os binários de plataforma (que são opcionais dentro do pacote `bun`); o runtime deixa de vir junto, como antes.

## Consequências

- Uma única dependência e uma única matriz de plataformas, herdada do pacote oficial.
- `npm i -g` segue funcionando sem Bun global; agora há `postinstall` no caminho (antes não havia).
- `--ignore-scripts` e `--omit=optional` deixam de garantir runtime embutido; a mensagem de erro do launcher aponta `ASTRO_BUN_PATH` (ou um Bun no `PATH`).
- D-02 passa a citar o ADR-0018 como exceção de dependência de runtime.
- A decisão não muda o contrato do launcher (`bun dist/cli.js <args>`, `stdio` herdado, código/sinal propagados).

## Alternativas descartadas

- Manter a lista de `@oven/bun-*` no ASTRO: duplicação e drift a cada release do Bun (o problema que motivou esta emenda).
- Fixar o Bun só por `engines`/documentação: já falhava em campo (ADR-0017, contexto).
- Baixar o binário em `postinstall` próprio: rede e extração caseira, mais superfície de supply-chain.
