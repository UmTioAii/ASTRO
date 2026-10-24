# ASTRO

Objetivo: harness de agentes de código com governança — cada agente executa só o que o escopo dele permite, com a conta e o orçamento designados, e todo run deixa rastro auditável.

## O que é o ASTRO

Runtime local, terminal-first, para tarefas de código com agentes. Um pedido vira uma sessão que planeja, lê, escreve e executa dentro de um escopo declarado, com custo medido por chamada e auditoria append-only.

| Capacidade | Onde |
|---|---|
| Multi-agente com handoff pelo orquestrador | `src/session.ts`, `src/tools/handoff.ts` |
| Multi-provider (builtin + plugins) | `src/provider/`, `src/plugins.ts` |
| Ledger de uso e auditoria sanitizada | `src/ledger.ts`, `src/audit.ts` |
| Tools com manifesto e allowlist | `src/tools/`, `src/sdk/tool.ts` |
| Sandbox opcional para comandos | `src/tools/run-command.ts:107` |
| Zero dependências de runtime | `package.json` (só devDependencies) |

## Diferenciais

| Diferencial | O que faz | Onde |
|---|---|---|
| Escopo por agente | Cada agente declara modelo, tools e orçamento; tool fora da allowlist é negada e auditada como `tool.denied` | `src/config.ts:321`, `src/tools/executor.ts:72` |
| Custo e quota imputados por domínio | Ledger por agente/provider/domínio; quota diária e mensal bloqueia antes da chamada ao provider | `src/quota.ts`, `src/team.ts` |
| Handoff entre agentes pelo orquestrador | Troca de agente ativo com evento `agent.switch` auditável, sem canal direto entre agentes | `src/session.ts:54`, `src/session.ts:229` |
| Rastro completo com custo | Cada completion grava tokens e custo no ledger; cada run registra só `taskHash`, nunca o prompt | `src/app.ts:215`, `src/ledger.ts` |

## Início rápido

```bash
git clone https://github.com/UmTioAii/ASTRO.git && cd ASTRO
bun install --frozen-lockfile
cp astro.config.example.json astro.config.json
export NVIDIA_API_KEY="..."     # ou OPENROUTER_API_KEY; ver tabela abaixo
bun src/cli.ts run "diga oi"
```

## Variáveis de inicialização

| Nome | Obrigatória | Padrão | Onde é lida | O que faz |
|---|---|---|---|---|
| `<credentialRef>` (ex.: `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`) | sim, para providers openai-compat | — | `src/app.ts:122` | Chave do provider; o nome vem da config (`credentialRef`, `src/config.ts:17`), o valor só do ambiente |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | não | desligado | `src/tracing.ts:137` | Habilita tracing OTLP/HTTP com spans de run, step, tool e provider |
| `ASTRO_CONFIG_REGISTRY` | não | — | `src/cli.ts:484` | Registry (`owner/repo`) usado por `config push/pull` |
| `GH_TOKEN` ou `GITHUB_TOKEN` | só em `config push/pull` | — | `src/cli.ts:489` | Token do registry de configs |
| `EVAL_THRESHOLD` | não | `0.85` | `.github/workflows/ci.yml` | Mínimo de pass rate do gate de eval no CI |

## Configuração (`astro.config.json`)

| Chave | Tipo | Padrão | Onde |
|---|---|---|---|
| `providers` | `Record<string, ProviderConfig>` | — | `src/config.ts` |
| `models` | `ModelConfig[]` | — | `src/config.ts` |
| `agent` | `AgentConfig` | — | `src/config.ts` |
| `agents` | `Record<string, NamedAgentConfig>` | ausente | `src/config.ts:321` |
| `tools` | `{ run_command?: { sandbox?: boolean } }` | `sandbox: false` | `src/config.ts` |
| `telemetry` | `{ enabled, endpoint, sampleRate }` | desligada | `src/config.ts` |
| `quota` | `Record<domínio, { dailyTokens?, monthlyCostUsd? }>` | sem enforcement | `src/config.ts` |
| `cache` | `{ enabled, ttlHours, maxEntries }` | desligada; 24h; 10000 | `src/config.ts` |
| `plugins` | `string[]` | — | `src/plugins.ts` |
| `version` | semver `x.y.z` | — | `src/config.ts:129` |
| `team` | `{ projectBudgetUsd?, agentQuotas?, auditWebhook? }` | — | `src/team.ts` |
| `paths` | `{ ledger, audit }` | — | relativo ao `--cwd` |

Exemplo mínimo (sem segredo; só `credentialRef`):

```json
{
  "providers": { "nvidia": { "kind": "openai-compat", "baseUrl": "https://integrate.api.nvidia.com/v1", "credentialRef": "NVIDIA_API_KEY" } },
  "models": [{ "provider": "nvidia", "id": "meta/llama-3.3-70b-instruct", "tags": ["writing-code", "tools"], "context": 131072 }],
  "agent": { "model": "nvidia/meta/llama-3.3-70b-instruct", "maxSteps": 12, "tools": ["read_file", "write_file", "run_command", "grep", "list_dir", "edit", "lsp", "pipeline"] },
  "paths": { "ledger": ".astro/ledger.jsonl", "audit": ".astro/audit.jsonl" }
}
```

O exemplo completo, com os três providers, está em `astro.config.example.json`. Guia de criação de providers e SDKs: `docs/providers.md`.

## Comandos da CLI

| Comando | O que faz | Flags |
|---|---|---|
| `run "<pedido>"` | Executa uma tarefa ponta a ponta e imprime resposta + resumo | `--config`, `--cwd` |
| `eval` | Roda o golden dataset em modo mock; gate de regressão | `--threshold`, `--golden`, `--report`, `--baseline`, `--write-baseline` |
| `bench` | Latência, tokens/s e custo por modelo | `--config`, `--models`, `--runs`, `--out` |
| `serve` | Expõe `/metrics` no formato Prometheus | `--port` |
| `replay <run-id>` | Re-executa a tarefa e compara métricas com o run original | `--task`, `--config`, `--cwd` |
| `health` | Valida config, credenciais e conectividade dos providers | `--config` |
| `config <push\|pull> <nome>` | Publica/recupera config no registry | `--registry`, `--config`, `--token` |

## Segurança

| Garantia | Invariante | Teste |
|---|---|---|
| Segredo só via ambiente; redação de segredo em auditoria e provider | I-03 | `tests/audit.test.ts`, `tests/provider.test.ts`, `tests/app.test.ts:52` |
| Tool fora da allowlist não executa; negação auditada | I-01 | `tests/tools.test.ts`, `tests/tool-isolation.test.ts` |
| Caminho confinado ao `--cwd` com resolução real (symlink/junction bloqueado); sandbox opcional para `run_command` | I-11 | `tests/tools.test.ts`, `tests/security-f00.test.ts`, `tests/sandbox.test.ts` |
| `run_command` sanitiza o ambiente do filho (remove `credentialRef`s e nomes de segredo) | I-03 | `tests/security-f00.test.ts` |
| `write_file` recusa o estado do harness (`.astro/` e caminhos protegidos) | I-11 | `tests/security-f00.test.ts` |
| Falha terminal auditada com `run.stopped` (reason e `errorClass`) | I-04 | `tests/security-f00.test.ts` |
| Prompt não persistido; `run.started` guarda só `taskHash` | I-04 | `src/app.ts:215`, `tests/app.test.ts:48` |
| Quota diária/mensal e budget bloqueiam antes do gasto | I-17 | `tests/quota.test.ts`, `tests/team.test.ts` |

## Documentação

| Arquivo | Função |
|---|---|
| `docs/CONTRIBUTING-DOCS.md` | Padrão de escrita para toda documentação |
| `docs/workflow.md` | Fluxo de branch, commit, PR e merge |
| `docs/review-checklist.md` | Checklist de revisão de PR |
| `docs/invariants.md` | Invariantes I-01 a I-22 com cobertura no código |
| `docs/decisions.md` | Decisões D-01 a D-20 e correspondência com a trilha |
| `docs/providers.md` | Providers, credenciais, SDKs e smoke manual |
| `docs/roadmap.md` | Fases concluídas F0–F7 |
| `docs/roadmap-complementar.md` | Camadas 0–3 planejadas |

## Status

| Escopo | Estado | Referência |
|---|---|---|
| F0–F7 (fundação, multi-agent, tools, eval, produção, ecossistema) | concluído | `docs/roadmap.md` |
| Camadas 0–3 (F-xx, T1–T4, C1–C7, P-01–P-04) | planejado | `docs/roadmap-complementar.md`, issues #55–#65 |

## Contribuir e licença

Contribuição segue `docs/workflow.md` (issue, branch por item, PR com revisão obrigatória, squash merge). Suíte: `bun test` e `bun run typecheck`. Licença: MIT (`LICENSE`).
