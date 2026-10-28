<div align="center">

# ASTRO

**Multi-agent coding harness with deterministic model routing, append-only audit, and cost governance.**

[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## What is ASTRO

ASTRO is a local, terminal-first harness for AI coding agents. A request becomes a session that plans, reads, writes and executes inside a declared scope, with cost metered per call and an append-only audit trail.

Multiple named agents, each bound to a model or profile, communicate through durable handoffs. The LLM never chooses its own model — the config does. That is the difference between a demo and a system you can audit.

| Concern | How ASTRO handles it |
|---|---|
| Which model ran this step? | Every completion is recorded in the ledger: agent, provider (the real one, not the wrapper), model, tokens, cost. |
| How much did this task cost? | Attributed per agent (and profile), per provider, per quota domain; checked before the call. |
| Can I reproduce a failed run? | Handoffs are durable artifacts (ack, CAS, idempotent); the ledger is append-only and replayable. |
| Can a subagent escalate privileges? | No — each agent has its own tool allowlist; denied calls are audited. |
| Can a provider outage kill a run? | No — fallback chain by priority, retrying only transient errors. |

## Quick start

```bash
git clone https://github.com/UmTioAii/ASTRO.git && cd ASTRO
bun install --frozen-lockfile
cp astro.config.example.json astro.config.json
export NVIDIA_API_KEY="..."      # credentialRef from your config
bun src/cli.ts run "create a hello.ts that exports hello()"
```

Secrets never live in config files and are never logged: `openai-compat` keys come only from environment variables named by `credentialRef`; `codex-oauth` reads a local credentials file (`credentialsPath`). The full three-provider example lives in `astro.config.example.json`; the provider guide is `docs/providers.md`.

## Configuration (`astro.config.json`)

| Key | Shape | Default | Where |
|---|---|---|---|
| `providers` | `Record<string, { kind, credentialRef?, baseUrl?, credentialsPath?, quotaDomain?, priority?, fallback?, maxRetries?, retryBackoffMs? }>` | — | `src/config.ts` |
| `models` | `{ provider, id, tags, context, price? }[]` | — | `src/config.ts` |
| `modelPool` | `Record<profile, { model, capabilities?, fallback? }>` | absent | `src/registry.ts` |
| `agent` | `{ model XOR profile, maxSteps, tools, entryAgent? }` | — | `src/config.ts` |
| `agents` | named agents inheriting from `agent` | absent | `src/config.ts` |
| `handoff` | `{ ackTimeoutMs }` | `30000` | `src/session.ts` |
| `pricing` | `Record<"provider/model-id", PriceConfig>` overriding `model.price` | absent | `src/registry.ts` |
| `quota` | per-domain `{ dailyTokens?, monthlyCostUsd? }` | no enforcement | `src/quota.ts` |
| `team` | `{ projectBudgetUsd?, agentQuotas?, auditWebhook? }` | — | `src/team.ts` |
| `budget` | `{ scope: day\|month\|project\|use-as-you-go, limitUsd, warnAt?, onExceed?, hardCeilingUsd? }` | absent (schema only until #132 parts 2–4) | `src/config.ts` |
| `run` | `{ maxTurns?: positive int \| "unlimited" }` (`unlimited` exige `limitUsd` ou `hardCeilingUsd`; cap nunca eleva `agent.maxSteps`) | `agent.maxSteps` | `src/config.ts` |
| `tools` | `{ run_command: { sandbox } }` | `sandbox: false` | `src/tools/run-command.ts` |
| `cache` | `{ enabled, ttlHours, maxEntries }` | off; 24h; 10000 | `src/cache.ts` |
| `telemetry` | `{ enabled, endpoint, sampleRate }` | off | `src/telemetry.ts` |
| `plugins` | `string[]` | — | `src/plugins.ts` |
| `paths` | `{ ledger, audit }` (relative to `--cwd`) | — | `src/ledger.ts` |

Minimal valid config (note: `id` is the bare model id; the `provider/id` form is used in `agent.model`):

```json
{
  "providers": { "nvidia": { "kind": "openai-compat", "baseUrl": "https://integrate.api.nvidia.com/v1", "credentialRef": "NVIDIA_API_KEY" } },
  "models": [{ "provider": "nvidia", "id": "meta/llama-3.3-70b-instruct", "tags": ["writing-code", "tools"], "context": 131072 }],
  "agent": { "model": "nvidia/meta/llama-3.3-70b-instruct", "maxSteps": 12, "tools": ["read_file", "write_file", "run_command"] },
  "paths": { "ledger": ".astro/ledger.jsonl", "audit": ".astro/audit.jsonl" }
}
```

Model pool and profiles are implemented — a profile replaces `model` (both together are rejected), and pricing stays inherited from `models[]` (never per profile). Fragment of `astro.config.example.json` (needs the `codex` provider and its `gpt-5.5` model from the full example):

```json
{
  "modelPool": { "cheap": { "model": "nvidia/meta/llama-3.3-70b-instruct" }, "premium": { "model": "codex/gpt-5.5" } },
  "agent": { "model": "nvidia/meta/llama-3.3-70b-instruct", "maxSteps": 12, "tools": ["read_file", "handoff"] },
  "agents": { "planner": { "profile": "premium", "tools": ["handoff"] }, "coder": { "profile": "cheap" } }
}
```

## CLI

All commands run as `bun src/cli.ts <command>`.

| Command | What it does | Flags |
|---|---|---|
| `run "<prompt>"` | runs a task end to end; prints answer and summary | `--config`, `--cwd` |
| `replay <run-id>` | re-runs the task and compares metrics with the original run | `--task`, `--config`, `--cwd` |
| `resume <run-id>` | resumes an interrupted run from the recorded active agent (ledger is the source) | `--task`, `--config`, `--cwd` |
| `eval` | golden dataset in mock mode; regression gate | `--threshold`, `--golden`, `--report`, `--baseline`, `--write-baseline` |
| `bench` | latency, tokens/s and cost per model | `--config`, `--models`, `--runs`, `--out` |
| `health` | validates config, credentials and provider connectivity | `--config` |
| `handoff show <handoff_id>` | inspects a durable handoff artifact with its compaction audit | `--config` |
| `cost --by-agent` | cost per agent (and profile) read from the ledger | `--config` |
| `pool <list\|health>` / `agents list` | lists model-pool profiles with per-profile health / lists named agents | `--config` |
| `config <push\|pull> <name>` | publishes/retrieves a config in a GitHub registry | `--registry`, `--config`, `--token` |
| `serve` | exposes `/metrics` in Prometheus format | `--port` |

## Environment variables

| Name | Required | Where | Purpose |
|---|---|---|---|
| `<credentialRef>` (e.g. `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`) | for openai-compat providers | `src/app.ts` | provider key; the name comes from config, the value only from the environment |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | `src/tracing.ts` | enables OTLP tracing (run, step, tool and provider spans) |
| `ASTRO_CONFIG_REGISTRY` | no | `src/cli.ts` | registry (`owner/repo`) used by `config push/pull` |
| `GH_TOKEN` / `GITHUB_TOKEN` | only for `config push/pull` | `src/cli.ts` | registry token |

## Security

| Guarantee | Invariant | Tests |
|---|---|---|
| Secrets only from the environment; redaction in audit, ledger, errors and prompts | I-03 | `tests/security-*.test.ts`, `tests/audit.test.ts` |
| Tools outside the allowlist never execute; denials are audited | I-01 | `tests/tools.test.ts`, `tests/tool-isolation.test.ts` |
| Paths confined to `--cwd` (symlink/junction resolved); optional sandbox for `run_command` | I-11 | `tests/security-f00.test.ts`, `tests/sandbox.test.ts` |
| Child shell environment sanitized (credentialRefs and secret names removed) | I-03 | `tests/security-f00.test.ts` |
| Harness state (`.astro/`) not writable by tools | I-11 | `tests/security-f00.test.ts` |
| Prompts never persisted; `run.started` stores only `taskHash` | I-04 | `tests/golden-f2.test.ts` |
| Quota and budget block before spending | I-17 | `tests/quota.test.ts`, `tests/team.test.ts` |
| Handoff is single-path: idempotent by `handoff_id` (CAS), identity verified at reception, digest-checked artifacts | I-18 | `tests/handoff-cas.test.ts`, `tests/handoff-compact.test.ts` |

## Design principles

Determinism over flexibility; security as a contract; every action auditable; extend, don't recreate.

## Status

| Scope | State | Reference |
|---|---|---|
| F0–F7 (foundation, multi-agent, tools, eval, production, ecosystem) | done | `docs/roadmap.md` |
| Layer 0 (durable handoff with ack/CAS/compaction, model pool and profiles, per-agent cost, provider fallback) | in progress | F-03, F-07, F-10, F-23..F-30 merged (#75–#102); C6 merged (#103, #106); F-31 in progress (#86) |
| C1–C5, C7 (skills, MCP, web tools, advanced agents, quality, organization), T1–T4 (REPL, TUI, sessions) | planned | `docs/roadmap-complementar.md`, issues #55–#65 |

## Documentation

| File | Purpose |
|---|---|
| `docs/CONTRIBUTING-DOCS.md` | documentation standard |
| `docs/workflow.md` | branch, commit, PR and merge flow |
| `docs/review-checklist.md` | PR review checklist |
| `docs/invariants.md` | invariants I-01..I-22 mapped to code |
| `docs/decisions.md` | decisions D-01..D-20 |
| `docs/adr/` | architecture decision records |
| `docs/providers.md` | providers, credentials and SDKs |
| `docs/roadmap.md` / `docs/roadmap-complementar.md` | completed phases / planned layers |

## Contributing and license

Contributions follow `docs/workflow.md`: one issue per change, a branch per item, PR with mandatory independent review, squash merge. Suite: `bun test` and `bun run typecheck`. License: MIT (`LICENSE`).
