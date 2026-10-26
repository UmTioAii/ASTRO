# Providers, credenciais e SDKs

Objetivo: guia de configuração de providers, validação manual de credenciais e criação de extensões (providers e tools).

| Cobre | Não cobre |
|---|---|
| Providers builtin, credenciais, preço, SDK de provider, SDK de tool, smoke manual | Contratos internos de sessão (ver `docs/decisions.md`) |

## Providers builtin

| Kind | Providers | Credencial | Onde |
|---|---|---|---|
| `openai-compat` | NVIDIA NIM, OpenRouter | `credentialRef` (env nomeada) | `src/provider/openai-compat.ts` |
| `codex-oauth` | Codex OAuth | `~/.codex/auth.json` (somente leitura) | `src/provider/codex-oauth.ts` |

Kinds de plugin são aceitos com `kind` custom e factory registrada por plugin (`src/plugins.ts`, `src/config.ts`).

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

Profiles da model pool aceitam `fallback?: string[]` com nomes de outros profiles. A validação no startup rejeita profile inexistente, autorreferência e ciclo (a mensagem cita o caminho, ex.: `p1 -> p2 -> p1`); `[]` é aceita e equivale a não ter fallback. O consumo da cadeia no runtime entra na F-31b.

`bun src/cli.ts pool health` estende `health` (F6-6): imprime `{status, profiles, providers}` em JSON, com status por profile — `ok` quando o provider primário responde, `degraded` quando ele está fora mas há fallback saudável na cadeia, `down` quando nenhum caminho responde. Sai 0 só com o agregado `ok`.

## SDK de provider (`src/sdk/provider.ts`)

Contratos: `Provider`, `CompletionRequest/Response`, `ToolDef`, `ProviderError` com `ErrorClass` (D-18). Fábrica registrável: `defineProviderFactory(kind, create)`. Harness de teste: `createMockProvider(script)` com `mockResponse`/`mockToolCall`.

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
