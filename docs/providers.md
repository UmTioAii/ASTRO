# Providers, credenciais e SDKs

Objetivo: guia de configuração de providers, validação manual de credenciais e criação de extensões (providers e tools).

| Cobre | Não cobre |
|---|---|
| Providers builtin, credenciais, preço, SDK de provider, SDK de tool, smoke manual | Contratos internos de sessão (ver `docs/decisions.md`) |

## Providers builtin

| Kind | Providers | Credencial | Onde |
|---|---|---|---|
| `openai-compat` | NVIDIA NIM, OpenRouter, Ollama/LM Studio | `credentialRef` (env nomeada; opcional para provider local) | `src/provider/openai-compat.ts` |
| `codex-oauth` | Codex OAuth | `~/.codex/auth.json` (somente leitura) | `src/provider/codex-oauth.ts` |

Kinds de plugin são aceitos com `kind` custom e factory registrada por plugin (`src/plugins.ts`, `src/config.ts`).

## Perfis globais e `--provider` (#201)

Perfis vivem em `~/.astro/providers.json` (`ASTRO_HOME` sobrescreve), modo 0600, e nunca guardam segredo: só `credentialRef`. O schema rejeita campo desconhecido, header de autenticação e credencial embutida na `baseUrl`.

| Precedência | Ordem |
|---|---|
| Definição do provider | `astro.config.json` > perfil global de mesmo nome |
| Provider ativo | `--provider` > `ASTRO_PROVIDER` > `activeProfileId` > provider do `agent.model` |
| Modelos | união; o projeto vence no mesmo `provider/id` |

`OPENAI_API_KEY` + `OPENAI_MODEL` (e `OPENAI_BASE_URL` opcional) montam um perfil efêmero `env`, usado só naquela execução e nunca gravado. Sem `astro.config.json`, `chat`/`tui` usam baseline somente leitura (`read_file`, `list_dir`, `grep`); `run` exige config explícita, e escrita/shell exigem config em qualquer caso. Em projeto com `agent.profile`, `--provider` divergente é erro (o profile decide o modelo); `run.started` registra `providerSource` (definição) e `providerSelection` (quem escolheu).

CRUD: `/provider add` (catálogo ou custom), `/provider edit <nome|id>`, `/provider remove <nome|id>` e `/provider use <nome|id>`. Na TUI, `/provider` abre a tela cheia (a adicionar, e editar, d remover, enter ativar, esc voltar); `/provider use <nome>` continua trocando inline. Perfis do projeto e o perfil `env` são somente leitura; remover um perfil referenciado pelo projeto é recusado.

## Custo e preço

| Campo | Tipo | Comportamento |
|---|---|---|
| `price` | opcional por modelo | Sem preço curado, o ledger grava `costUsd: null` e o CLI mostra `n/d` |
| `price.fonte` / `price.verificado` | string / boolean | Curadoria: mantenha `verificado: false` até conferir na fonte |
| `pricing` (global) | `Record<"provider/model-id", PriceConfig>` | Sobrescreve `model.price` de modelos declarados para todo cálculo de custo; curadoria igual à de `price` |

Cálculo em `src/ledger.ts` (`estimateCost`), por 1M de tokens. Preço nunca vive no profile (ADR-0007); a tabela global é a única sobrescrita.

## Fallback entre providers (C6)

| Campo | Default | Comportamento |
|---|---|---|
| `priority` | 100 | Ordem da cadeia: menor atende primeiro; empate mantém a ordem declarada |
| `fallback` | `[]` (desligado) | Providers a tentar em falha, em ordem de prioridade |
| `maxRetries` | 2 | Retries por provider além da primeira tentativa; inteiro não negativo |
| `retryBackoffMs` | 1000 | Backoff linear entre retries (`retryBackoffMs × attempt`) |

Só `transient_rate_limit` e `outage` retryam (D-14); erros duros vão direto ao próximo da cadeia; esgotada a cadeia, o último erro sobe. Cada tentativa audita `provider.failure` {provider, errorClass, attempt} e o atendimento audita `provider.success` {provider, latencyMs, attempt}; o ledger registra o provider real que atendeu, não o wrapper. Falha de fábrica (ex.: credencial de um fallback ausente) não aborta a cadeia: vira `provider.failure` e o próximo é tentado. Composição com o retry interno do openai-compat (F2, cap 3, janela 60s): o limite composto por provider é 3 × (1 + `maxRetries`) chamadas HTTP.

Gerenciamento: `bun src/cli.ts providers list` (prioridade e cadeia), `providers health` (relatório com prioridade) e `providers test <provider>` (1 chamada real mínima) — `src/health.ts`, `src/cli.ts`.

## Fallback por profile (F-31)

Profiles da model pool aceitam `fallback?: string[]` com nomes de outros profiles. A validação no startup rejeita profile inexistente, autorreferência e ciclo (a mensagem cita o caminho, ex.: `p1 -> p2 -> p1`); `[]` é aceita e equivale a não ter fallback.

O roteador `ProfileFallbackProvider` (`src/provider/profile-fallback-provider.ts`) tenta o profile pedido e percorre `fallback` em ordem declarada (profundidade primeiro, sem repetir profile), reescrevendo `model` para o modelo de cada profile. A política é a existente (F-01/D-14): `auth`/`invalid_request` abortam, `hard_quota` pula e `transient_rate_limit`/`outage` caem para o próximo profile depois dos retries internos. Cada troca audita `profile.failure`/`profile.fallback`; eventos `provider.*` do C6 carregam o `profile` afetado.

O `app` monta o roteador quando a config declara `modelPool`. Providers são criados sob demanda: credencial ausente em um profile não impede o fallback. A cadeia de cada profile é sempre embrulhada pelo C6 (retry da F-01 e `profile` no audit); requisição sem `profile` segue o caminho anterior (model base e C6 só com fallback de provider declarado).

O ledger (F-31d) grava a identidade efetiva que atendeu — `provider`, `model`, `credentialRef`, `quotaDomain` e o preço do modelo de destino — e a trilha aditiva `fallbacks: [{profile, from_provider, to_provider, reason}]`; `profile` continua sendo o profile pedido, não o destino. A quota é checada por entry da cadeia, no domínio de destino e antes da chamada, então `hard_quota` na origem não bloqueia um destino saudável. `credential.acquired` só é emitido quando o provider é criado de fato, com a identidade real; cache hit não adquire credencial. `run.started` traz o `profile` do agent.

`bun src/cli.ts pool health` estende `health` (F6-6): imprime `{status, profiles, providers}` em JSON, com status por profile — `ok` quando o provider primário responde, `degraded` quando ele está fora mas há fallback saudável na cadeia, `down` quando nenhum caminho responde. Sai 0 só com o agregado `ok`.

## Streaming (T3)

Com `CompletionRequest.onToken`, o `openai-compat` pede `stream: true` + `stream_options.include_usage` e consome SSE (`data:`), agregando conteúdo, tool calls fatiadas e usage. Resposta 200 que não é `text/event-stream` cai no parser JSON normal (sem deltas), e frames de erro (`data: {"error":...}`) ou stream sem nenhum frame viram `ProviderError("outage")`. Depois do primeiro token não há retry nem troca de provider/profile (`streamStarted`), para não duplicar texto; o custo usa o usage do chunk final (sem chunk de usage, usage fica zero).

## SDK de provider (`src/sdk/provider.ts`)

Contratos: `Provider`, `CompletionRequest/Response`, `ToolDef`, `ProviderError` com `ErrorClass` (D-18). Fábrica registrável: `defineProviderFactory(kind, create)`. Harness de teste: `createMockProvider(script)` com `mockResponse`/`mockToolCall`. `Provider.complete(req, signal?)` recebe o `AbortSignal` de cancelamento (F-06): repasse-o ao `fetch` e relance abort sem classificá-lo como erro de provider. No runtime, a troca de provider/profile no fallback e no handoff multi-agent passa por `approveSwap` (F-19); sem ele a troca fica `pending` e o run para em ponto seguro. O multi-agent usa `providerFor(model)` para falar com o provider do modelo do agente (F-31d), não o da entrada.

Exemplo completo: `examples/provider-ollama/ollama.ts` (~90 linhas).

## SDK de tool (`src/sdk/tool.ts`)

Contratos: `Tool`, `ToolManifest`, `ToolContext`, `ToolResult`, `ToolError`. `validateManifest` (I-12) falha cedo no load do plugin via `defineTool`. Harness: `createMockTool`. Erros voltam como resultado (`toolFailure`/`toolSuccess`), não como exceção.

Exemplo completo: `examples/tool-sql/sql.ts` (~70 linhas).

## Criando um provider

| Passo | O quê |
|---|---|
| 1 | Implementar `Provider.complete(req)` devolvendo `CompletionResponse` |
| 2 | Classificar falhas com `ProviderError` (`transient_rate_limit`, `hard_quota`, `auth`, `outage`, `invalid_request`) |
| 3 | Ler segredo só de `env[credentialRef]` (I-03) — nunca da config em claro |
| 4 | Envolver com `defineProviderFactory("meu-kind", create)` e exportar em plugin `definePlugin({ name, providers: [factory] })` |
| 5 | Testar com `createMockProvider` e um servidor mock — sem rede real |

## Smoke manual por provider

Os testes automatizados nunca chamam providers reais. Para validar credenciais de verdade, uma vez por provider:

| Provider | Preparação | Comando | `agent.model` |
|---|---|---|---|
| NVIDIA NIM | exportar `NVIDIA_API_KEY` | `bun src/cli.ts run "diga oi"` | `nvidia/meta/llama-3.3-70b-instruct` |
| OpenRouter | exportar `OPENROUTER_API_KEY` | idem | `openrouter/openai/gpt-4o-mini` |
| Codex OAuth | sessão autenticada em `~/.codex/auth.json` | idem (sem exportar chave) | `codex/gpt-5.5` |

Variável ausente: falha antes de qualquer chamada, com `erro: defina <NOME_DA_VARIAVEL> no ambiente` — a mensagem cita o nome, nunca o valor.
