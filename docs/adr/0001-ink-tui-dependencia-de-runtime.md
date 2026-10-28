# ADR-0001: Ink e React como primeira dependência de runtime (TUI isolada)

- Status: aceita
- Data: 2026-10-28
- Issue: #63
- Decisões relacionadas: D-02

## Contexto

A T2 pede painéis, markdown, editor multi-linha, autocomplete e redimensionamento. O REPL zero-dep da T1 resolve chat e governança, mas reimplementar reconciliação de layout e um editor sobre ANSI cru aumentaria muito o código e os casos de borda. A restrição é D-02: nada de dependência de runtime.

## Decisão

Adotar **Ink 8 + React 19** como única dependência de runtime, carregada por `import()` dinâmico apenas no comando `astro tui`. `run`, `eval`, `bench`, `chat`, `health` e o restante do CLI continuam sem carregar Ink.

## Consequências

- Ganho: layout, foco, resize e testes de componente (`ink-testing-library`) prontos; menos código de terminal para manter.
- Custo: `bun install` passa a ser obrigatório para usar a TUI; superfície de supply-chain nova (lockfile fixo e faixa `^`); bundle/startup maior só no subcomando `tui`.
- Invariantes afetados: D-02 ganha exceção explícita; I-03 e I-01 não mudam (a TUI consome a mesma `AgentSession` e a mesma allowlist).

## Alternativas descartadas

- TUI ANSI zero-dep: reescrever layout, editor e resize; custo alto e risco de regressão visual.
- UI web local (Bun.serve + SSE): resolveria o visual, mas fica fora do terminal e não fecha o escopo da T2.
- Continuar só no REPL: não atende painéis, autocomplete nem keybindings pedidos na T2.
