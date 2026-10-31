# Decisões arquiteturais (D-xx)

Objetivo: registrar o motivo de cada escolha com ID estável.

| Cobre | Não cobre |
|---|---|
| Decisões D-01 a D-22 do repo e a correspondência com a trilha de planejamento | Invariantes (em `docs/invariants.md`) e ADRs (em `docs/adr/`) |

IDs estáveis; não renumerar.

| ID | Decisão | Contexto / Alternativas | Impacto |
|---|---|---|---|
| D-01 | **Runtime: Bun + TypeScript strict** | Alternativas: Node + tsx, Deno. Bun dá startup rápido, APIs nativas (fetch, WebSocket, SQLite), bundler integrado. | Zero dependências de runtime; `bun test` e `bun run typecheck` são comandos nativos. |
| D-02 | **Zero dependências de runtime** | Apenas stdlib (`node:fs`, `node:path`, `node:crypto`, `node:os`) + Bun globals. Nada de `npm install` para produção. Exceções: Ink/React carregados sob demanda só em `astro tui` (ADR-0001) e o runtime Bun empacotado na distribuição npm (ADR-0017, revisto pelo ADR-0018). | Runtime pinado pela release; binário único no caminho Bun; +~100 MB no install npm. |
| D-03 | **CredentialRef pattern** — segredo só em variável de ambiente nomeada | Config guarda `credentialRef: "NVIDIA_API_KEY"`, nunca o valor. Codex lê `~/.codex/auth.json`; o login device da TUI grava esse arquivo (0600). | Segredo nunca entra em config, log, audit, ledger, erro ou prompt (I-03). |
| D-04 | **Provider abstraction por `kind` discriminado** | `openai-compat` (NVIDIA NIM, OpenRouter) e `codex-oauth`. Interface `Provider` com `complete()`. | Adicionar provider = novo `kind` + factory em `createProvider()`. |
| D-05 | **Model registry com tags de vocabulário fechado (D-17)** | `ROLE_TAGS` (planning, analysis, writing-code…) + `CAPACITY_TAGS` (tools, reasoning, long-context…). Tag desconhecida = config inválida. | Filtro semântico (`registry.list({tags})`), validação estática, evita tag soup. |
| D-06 | **Tool manifest obrigatório (I-12)** | `ToolManifest`: name, description, parameters, risk (low/medium/high), permission, timeoutMs, retryable. | Allowlist por config (I-01), execução negada por default, auditoria de risco. |
| D-07 | **Allowlist por default (I-01)** | `agent.tools` lista nomes permitidos; tool fora da lista não executa. `ToolExecutor` valida contra `allow`. | Superfície de ataque mínima; nova tool exige decisão explícita no PR. |
| D-08 | **Confinamento de caminho ao `cwd` (I-11)** | `resolveFrom(cwd, path)` resolve relativos; `..` e symlinks não escapam. `run_command` herda `cwd`. | Escrita/leitura fora do workspace bloqueada. |
| D-09 | **Auditoria append-only JSONL com sanitização (I-03)** | `Auditor` escreve eventos com `seq`, `ts`, `run`, `tipo`, `payload`. `sanitize()` redige chaves/valores que parecem segredos. | Rastreabilidade total sem vazar credenciais; `seq` garante ordem e detecção de truncamento. |
| D-10 | **Ledger append-only JSONL com custo estimado** | `LedgerEntry`: tokens in/out, `costUsd` (null se sem preço). `estimateCost()` usa `price` curado por modelo. | Custo por run, agregação por provider/modelo, alerta quando `costUsd === null`. |
| D-11 | **Task hash em vez de prompt persistido** | `shortTaskHash(task)` = SHA-256 truncado a 16 chars. Gravado em `run.started.payload.taskHash`. | Correlação de execuções sem persistir dado sensível do usuário. |
| D-12 | **Sessão single-agent com loop de steps** | `runSession`: system prompt → user task → completion → tool calls → repeat até `maxSteps` ou resposta final. | Determinístico, testável, custo controlado por `maxSteps`. |
| D-13 | **Workflow baseado em git worktrees** | `git worktree add .worktrees/<branch> -b <branch> origin/main`. Uma worktree por issue/PR. | Isolamento total; `main` nunca recebe commit direto; rebase fácil. |
| D-14 | **Taxonomia de erros de provider (D-18)** | `ProviderError.errClass`: `transient_rate_limit`, `hard_quota`, `auth`, `outage`, `invalid_request`. | Retry/backoff dirigido; UI pode distinguir "tente depois" de "configure credencial". |
| D-15 | **Config validation com defaults seguros** | `status: "active"` por modelo; `quotaDomain: "default"` por provider; modelo duplicado = erro. | Config mínima viável; falha rápida com mensagem acionável. |
| D-16 | **Squash merge only + linear history** | Branch protection: `allow_squash_merge=true`, `allow_merge_commit=false`, `allow_rebase_merge=false`, `required_linear_history=true`. | Histórico limpo; cada PR = um commit atômico com `Closes #n`. |
| D-17 | **Vocabulário fechado de tags** (ver D-05) | Duas listas imutáveis em `src/tags.ts`. Validação em `validateModel()`. | Extensão controlada via PR + ADR; sem typos silenciosos. |
| D-18 | **Taxonomia de erros** (ver D-14) | `ErrorClass` type + `ProviderError` class. Usado em `openai-compat.ts`, `codex-oauth.ts`. | Tratamento uniforme; logs e métricas por classe. |
| D-19 | **Ciclo de vida de modelo** | `ModelStatus`: `active` | `deprecated` | `disabled`. `Registry.require()` só devolve `active`. | Descontinuação segura; modelos legados ficam na config mas não são selecionáveis. |
| D-20 | **Quota domain por provider** | `quotaDomain` agrupa credenciais que compartilham limite (ex.: mesma conta OpenRouter). Default `"default"`. | Ledger e futuras quotas operam no domínio correto. |
| D-21 | **Perfis globais de provider** | `~/.astro/providers.json` (`ASTRO_HOME`) guarda perfis sem segredo; projeto vence por nome; ativo segue `--provider` > `ASTRO_PROVIDER` > `activeProfileId` > `agent.model`; env é efêmero e a baseline sem config é somente leitura. | CRUD pelo `/provider` e onboarding sem editar JSON (#201); a origem fica auditada em `run.started`. |
| D-22 | **Contagem de tokens por provider** | Pura e determinística: tokenizer nativo registrado por provider; senão estimativa documentada de 4 chars/token; resultado marcado `measured`/`estimate` e nunca zero para texto não vazio. `src/tokens.ts`. | Compaction (S-17) e overflow retry usam a mesma contagem; sem chamada de provider e sem segredo (I-03). |
| D-24 | **Modos de permissão por chamada** | `bypass`/`allow-edits`/`ask`, default `ask`, resolvidos depois do allowlist; troca de identidade pede aprovação em todos os modos, inclusive `bypass`. | `src/permissions.ts` e gate no executor com evento `permission.decision`; `.astro/`/`protectedPaths`, redação e cwd são piso fixo. `ask` sem TTY (CLI não interativa) nega com `permission.pending` e para. |

---

## Correspondência com a trilha de planejamento

A trilha de planejamento usa numeração própria de decisões. Pares e colisões conhecidos:

| Repo | Trilha | Observação |
|---|---|---|
| D-01 (Bun + TypeScript strict) | D-22 | Mesma decisão, números diferentes |
| D-05/D-17 (tags de vocabulário fechado) | D-10/D-17 | Mesmo conteúdo |
| D-14/D-18 (taxonomia de 5 classes de erro) | D-18 | Mesma decisão |
| D-20 (quota domain) | D-11 | Mesmo conceito (domínio de cota por conta/org) |
| D-08 (confinamento de caminho) | — | Sem par direto; na trilha, D-13 cobre workspace |
| D-09 (auditoria append-only) | D-15 | Trilha D-15 acrescenta corte físico por camada |
| D-12 (sessão single-agent) | D-12 | Colisão: na trilha, D-12 é a escada de troca com aprovação |
| D-13 (worktrees no fluxo de dev) | D-13 | Tema distinto: na trilha, D-13 é workspace de agentes |
| D-16 (squash merge) | D-16 | Colisão: na trilha, D-16 é aprovação bloqueante |
| D-19 (ciclo de vida de modelo) | D-19 | Colisão: na trilha, D-19 é classe de equivalência |
| D-22 (contagem de tokens por provider) | D-22 (Bun + TypeScript strict) | Colisão: mesmo número, decisões distintas |

Decisões novas da trilha (escada de troca, classe de equivalência, aprovação bloqueante) entram nesta tabela a partir de D-21, com a origem registrada. Renumerar os IDs atuais exige ADR, porque quebra referências em issues e PRs.

## Como adicionar uma decisão

1. Crie `docs/adr/NNNN-titulo-kebab.md` (template em `docs/adr/0000-template.md`).
2. Adicione linha na tabela acima com próximo ID sequencial.
3. Referencie no PR/issue: `D-22`.