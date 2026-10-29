Cliente MCP (Model Context Protocol) no ASTRO (C2, #56): config `mcpServers`, transports stdio/http/sse e registry com isolamento.

| Cobre | Não cobre |
|---|---|
| Config, transports, ciclo de vida, reconexão com backoff, modelo de confiança, adaptador de tools, fiação no `runTask` e CLI | Detalhes do protocolo JSON-RPC (`src/mcp/`) |

## Config (`mcpServers`)

| Campo | Regra | Default |
|---|---|---|
| `transport` | `stdio` \| `sse` \| `http` | obrigatório |
| `command` + `args` + `env` | `command` obrigatório em stdio | `args: []` |
| `url` + `headers` | `url` obrigatória em sse/http; header de autenticação só como `env:NOME`; valor literal com cara de credencial é recusado | — |
| `retryBackoffMs` | inteiro positivo, base do backoff exponencial entre reconexões; teto de 30s | `1000` |
| `timeoutMs` | inteiro positivo, por requisição | `30000` |
| `enabled` | booleano; `false` fica fora do registry | `true` |
| nome (`mcpServers.<nome>`) | `[A-Za-z0-9][A-Za-z0-9_-]*`, sem `__` (separador do namespace) nem `/` | — |

## Transports (`src/mcp/transport/`)

| Transport | Semântica |
|---|---|
| `stdio` | spawn do processo; JSON-RPC por newline. **Env sanitizado** (reuso do `sanitizedEnv`): herda do host só o que não parece segredo (PATH/HOME etc.); chaves, tokens e senhas são removidos (I-03). O `env` explícito da config é adicional |
| `http` | streamable HTTP: um POST por requisição com `mcp-session-id` mantido; resposta JSON ou evento `data:` de stream. **404 com sessão enviada = sessão expirada** → transporte morto → o registry reconecta com sessão nova. Erro de rede/5xx não mata: cada requisição é um fetch novo e se autocura |
| `sse` | legacy: GET abre o stream e recebe o `endpoint`; POST 2xx é fire-and-forget (respostas pelo stream, correlacionadas por id); POST não-2xx rejeita a pendência com `HTTP <status>` |

Timeout por requisição nos três: aborta só a própria pendência; o transporte segue usável.

## Registry (`src/mcp/registry.ts`)

- Namespace da tool vista pelo modelo: `mcp__<server>__<tool>`; colisão com builtin/plugin ou outra tool MCP é ignorada com warn (builtin nunca é sobrescrita).
- `connectAll` com isolamento: falha individual vira warn + `failed`, não derruba os demais.
- `call`: erro de tool (protocolo, transporte vivo) propaga cru, **sem reexecução**; morte de transporte reconecta **uma vez** (dedup por servidor; concorrentes compartilham a tentativa) e reenvia o `tools/call` — a tool pode executar duas vezes (at-least-once).
- Backoff: falha de conexão entra em cooldown exponencial (`retryBackoffMs × 2^(falhas−1)`, teto 30s); durante o cooldown, `call` falha rápido com `nova tentativa em <ms>` e **não spawna**. Sucesso zera o backoff.
- `close` é terminal: `call`/`connectAll` pós-`close` rejeitam "registro MCP fechado" e nada spawna depois.
- Ciclo de vida sem órfãos: todo cliente descartado é fechado antes; reconexão em voo respeta `close()`.

## Adaptador (`src/mcp/tool.ts`)

- A tool namespaced entra na **mesma allowlist** do agent (I-01); fora dela não aparece em `defs()` nem executa.
- Audit `mcp.call` com `{server, tool, durationMs, status}` — sem argumentos nem resposta (I-03); `isError` do servidor conta como `error`.
- Falha da tool vira `ToolResult` de erro; o timeout do executor cobre o pior caso do retry do registry.
- Manifesto: `risk: high`, `idempotent: false`, `retryable: false` (tool opaca) e `sideEffects` por transporte.

## Fiação (`src/app.ts`)

- `connectAll` no início do run; servidor que falhou fica indisponível e o run segue.
- Tool `mcp__*` na allowlist que não foi descoberta é pulada com warn; não derruba a config (só tool desconhecida sem prefixo continua erro).
- `env` explícito dos servidores MCP entra em `secretEnvNames`, exceto nomes de sistema (PATH/HOME/TEMP etc.): o `run_command` não vê os demais valores (I-03).
- `close()` no `finally` do run, inclusive quando a sessão falha — sem processo órfão.

## Modelo de confiança

Servidor MCP stdio é **código arbitrário**: roda com env sanitizado e o `command` é responsabilidade de quem escreve a config. Em `headers`, use `"env:NOME_DA_VARIAVEL"`: o valor é resolvido no momento da conexão, só chega ao servidor e nunca entra em config, log, audit ou erro (I-03). Header de autenticação com valor literal é recusado; valor com cara de credencial em header neutro também.

## CLI (`astro mcp list|test`)

- `astro mcp list`: conecta os habilitados e lista as tools descobertas; servidor caído vira `indisponível` e não derruba o comando.
- `astro mcp test <server> <tool> [--args '<json>']`: executa a tool via adaptador (audit `mcp.call` sem argumentos/resposta, I-03); `isError` sai com código 1.
- `--config <path>`: config alternativa (default: `astro.config.json`); flag repetida é rejeitada.
- `--args` vale só em `test` e é validado antes de conectar; `list` rejeita argumentos demais.

## Limitações e pendências

Kill de árvore no win32 e dreno de stderr no stdio (#115); framing SSE CRLF no sse (micro-PR pendente).

## Referências

#56, PRs #115/#116/#117/#143/#144 e issue #139 (headers por `env:NOME`); I-01/I-03/I-04 em `docs/invariants.md`; D-02 (zero deps), D-09 (auditoria).
