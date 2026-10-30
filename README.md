<div align="center">

# ASTRO

**A multi-agent coding harness with deterministic model routing, append-only audit, and cost governance.**

[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-007ACC)](https://www.typescriptlang.org)
[![npm: alpha](https://img.shields.io/npm/v/@umtioai/astro-harness/alpha?color=blue)](https://www.npmjs.com/package/@umtioai/astro-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

ASTRO is a local, terminal-first harness for AI coding agents. It turns every request into an auditable session that plans, reads, writes and runs code inside a declared scope, with cost metered on every call.

Running agents in real projects raises three questions: *which model ran this step*, *what did it cost*, and *can I reproduce this run*. ASTRO answers all three by design, not as an afterthought.

## Why ASTRO

| Question | How ASTRO handles it |
|---|---|
| Which model ran this step? | Every completion is recorded in an append-only ledger: agent, real provider, model, tokens and cost. |
| Who chooses the model? | Declared agents keep the configuration's model; runtime subagents can only choose inside the `list_model_candidates` snapshot, and the choice is recorded in the ledger. |
| How much did a task cost? | Costs are attributed per agent, per provider and per quota domain, and checked *before* each call. |
| Can I reproduce a failed run? | Handoffs are durable artifacts (ack, compare-and-swap, idempotent) and the ledger can be replayed. |
| Can a subagent escalate privileges? | No. Each agent has its own tool allowlist, and denied calls are audited. |
| Can a provider outage kill a run? | No. A priority fallback chain retries transient errors and moves to the next provider. |

## Key features

- **Multi-agent with durable handoffs.** Named agents, each bound to a model or a profile, pass work to each other through idempotent, verifiable handoffs.
- **Deterministic model routing.** Model pools and profiles let you assign the right model to each role, with the choice fixed by configuration.
- **Append-only audit.** An immutable, replayable ledger of every action, tool call and model response, with secrets redacted.
- **Cost governance.** Per-agent, per-provider and per-domain accounting, quota and budget controls that block before spending.
- **Least-privilege tools.** Per-agent tool allowlists. Subagents cannot escalate privileges.
- **Provider fallback.** Priority-based chains across OpenAI-compatible providers (NVIDIA, OpenRouter, and others) and Codex OAuth.
- **Terminal-first UX.** A non-interactive `run` command, an interactive `chat` REPL and a full-screen `tui`.

## Installation

**Requirements:** Node.js 18 or newer. The pinned Bun runtime ships as a platform dependency, so you do not need a global Bun installation.

```bash
npm install -g @umtioai/astro-harness@alpha
astro
```

After installing, run `astro` in an interactive terminal to open the TUI. Without a TTY it prints help, and `astro --help` lists every command. With no configuration, `astro` first opens the provider setup. The CLI reads `astro.config.json` from the directory where you run it.

Notes:

- To use your own Bun binary: `ASTRO_BUN_PATH=/path/to/bun astro`.
- The install materializes the Bun binary from the `bun` npm package (its `postinstall`). With `--omit=optional`, `--ignore-scripts`, or a `PATH`-only Bun, set `ASTRO_BUN_PATH` or make sure `bun` is on `PATH`.
- The install does not create or shadow a global `bun` or `bunx` command.
- The `alpha` tag is the current preview release.

## Quick start from source

```bash
git clone https://github.com/UmTioAii/ASTRO-Harness.git && cd ASTRO-Harness
bun install --frozen-lockfile
cp astro.config.example.json astro.config.json
export NVIDIA_API_KEY="..."   # the credentialRef named in your config
bun src/cli.ts run "create a hello.ts that exports hello()"
```

## Configuration

ASTRO reads `astro.config.json` from the working directory. A minimal valid configuration:

```json
{
  "providers": {
    "nvidia": {
      "kind": "openai-compat",
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "credentialRef": "NVIDIA_API_KEY"
    }
  },
  "models": [
    {
      "provider": "nvidia",
      "id": "meta/llama-3.3-70b-instruct",
      "tags": ["writing-code", "tools"],
      "context": 131072
    }
  ],
  "agent": {
    "model": "nvidia/meta/llama-3.3-70b-instruct",
    "maxSteps": 12,
    "tools": ["read_file", "write_file", "run_command"]
  },
  "paths": {
    "ledger": ".astro/ledger.jsonl",
    "audit": ".astro/audit.jsonl"
  }
}
```

Model pools and agent profiles are also supported. A full example with three providers lives in [`astro.config.example.json`](astro.config.example.json), and the provider guide is in [`docs/providers.md`](docs/providers.md).

**Secrets never live in configuration files and are never logged.** OpenAI-compatible keys come only from the environment variable named by `credentialRef`. The `codex-oauth` provider reads a local credentials file (`credentialsPath`).

Tool output is bounded: `outputLimit` (`{ "maxTokens": 8000, "shareOfWindow": 0.05 }` by default) caps each tool result at `min(maxTokens, shareOfWindow × model context)`. Oversized output is written to `.astro/outputs/<run>/` and the model receives the head, the tail and a source reference; `read_file` pages 350 lines with a 10-line overlap, and `grep` returns `{results, total, page, hasMore}` with 100 matches per page.

Sessions compact themselves before the context window fills: the trigger is `window − reserve`, where `reserve` is `max(15% of the window, 16.000)` or `compaction.buffer` when declared. The recent tail (15.000 tokens) is preserved, keeping the last user message when a previous turn exists (cut at a user message — or at the owning assistant of a tool pair for a single-task run); the older history is summarized without tools into a `CompactionArtifactV1` (Active, Blocked, Next Move, Relevant Files, Important Context) and `AGENTS.md` stays in the system prompt. Three failed compactions pause it for five minutes (`Compaction paused (3 failures, retry in Xs)`); `/compact force` clears the pause and records `compaction.manual`.

| Variable | Required | Purpose |
|---|---|---|
| `<credentialRef>` (e.g. `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`) | For OpenAI-compatible providers | Provider API key, named by your configuration. |
| `ASTRO_BUN_PATH` | No | Path to a Bun binary to use instead of the bundled one. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Enables OpenTelemetry tracing (run, step, tool and provider spans). |
| `ASTRO_CONFIG_REGISTRY` | No | Registry (`owner/repo`) used by `config push` and `config pull`. |
| `GH_TOKEN` / `GITHUB_TOKEN` | Only for `config push` / `config pull` | Registry token. |

## Usage

All commands run as `astro <command>`. From a clone, `bun src/cli.ts <command>` is equivalent.

| Command | Description |
|---|---|
| `run "<prompt>"` | Runs a task end to end and prints the answer and a summary. |
| `chat` | Interactive REPL with shared history, provider and model switching, and session management. |
| `tui` | Full-screen terminal UI with a conversation panel, input and live status bar. |
| `replay <run-id>` | Re-runs a task and compares metrics with the original run. |
| `resume <run-id>` | Resumes an interrupted run from its recorded agent. |
| `eval` | Runs the golden dataset in mock mode as a regression gate. |
| `bench` | Reports latency, tokens per second and cost per model. |
| `health` | Validates configuration, credentials and provider connectivity. |
| `cost --by-agent` | Shows cost per agent and profile, read from the ledger. |
| `handoff show <handoff_id>` | Inspects a durable handoff and its compaction audit. |
| `serve` | Exposes `/metrics` in Prometheus format. |

Inside `chat` and `tui`, slash commands such as `/model`, `/providers`, `/session`, `/compact`, `/export` and `/resume` are available. Run `/help` to list them all.

## Security

ASTRO treats security as a contract. These guarantees are enforced in code and covered by tests:

| Guarantee | Invariant | Tests |
|---|---|---|
| Secrets come only from the environment and are redacted in audit, ledger, errors and prompts. | I-03 | `tests/security-*.test.ts`, `tests/audit.test.ts` |
| Tools outside an agent's allowlist never execute, and denials are audited. | I-01 | `tests/tools.test.ts`, `tests/tool-isolation.test.ts` |
| File paths are confined to `--cwd` (symlinks and junctions resolved), with an optional sandbox for `run_command`. | I-11 | `tests/security-f00.test.ts`, `tests/sandbox.test.ts` |
| The child shell environment is sanitized: credential references and secret names are removed. | I-03 | `tests/security-f00.test.ts` |
| Harness state in `.astro/` cannot be written by tools. | I-11 | `tests/security-f00.test.ts` |
| Prompts are never persisted; `run.started` stores only a task hash. | I-04 | `tests/golden-f2.test.ts` |
| Quota and team budgets block before spending. | I-17 | `tests/quota.test.ts`, `tests/team.test.ts` |
| Handoffs are idempotent by `handoff_id`, verified on reception, and digest-checked. | I-18 | `tests/handoff-cas.test.ts`, `tests/handoff-compact.test.ts` |

Security issues should be reported privately through the repository's security advisories rather than public issues.

## Status and roadmap

ASTRO is in **alpha**. Interfaces may still change before a stable release.

| Scope | State |
|---|---|
| Foundation, multi-agent core, tools, evaluation, production hardening and ecosystem (F0–F7) | Done |
| Layer 0: durable handoffs, model pools and profiles, per-agent cost, provider fallback | In progress |
| Skills, MCP integration, web tools, advanced agents, quality and organization (C1–C5, C7) | Planned |
| REPL, TUI and sessions improvements (T1–T4) | Planned |

The detailed plan lives in [`docs/roadmap.md`](docs/roadmap.md) and [`docs/roadmap-complementar.md`](docs/roadmap-complementar.md).

## Local development

```bash
bun run cli -- --help        # run from source, no build needed
bun run cli -- run "..."     # run a task from source
bun run tui                  # open the TUI in a real terminal
bun run build                # build dist/cli.js and dist/launcher.js
bun run smoke                # build and check the launcher with Bun removed from PATH
bun link                     # after a build, make the global `astro` command point to this checkout
```

Test and type-check before opening a pull request:

```bash
bun test
bun run typecheck
```

## Documentation

| File | Contents |
|---|---|
| [`docs/workflow.md`](docs/workflow.md) | Branch, commit, pull request and merge flow. |
| [`docs/review-checklist.md`](docs/review-checklist.md) | Pull request review checklist. |
| [`docs/invariants.md`](docs/invariants.md) | Invariants I-01 to I-22, mapped to code. |
| [`docs/decisions.md`](docs/decisions.md) | Decisions D-01 to D-20. |
| [`docs/adr/`](docs/adr/) | Architecture decision records. |
| [`docs/providers.md`](docs/providers.md) | Providers, credentials and SDKs. |
| [`docs/roadmap.md`](docs/roadmap.md) and [`docs/roadmap-complementar.md`](docs/roadmap-complementar.md) | Completed phases and planned layers. |

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/workflow.md`](docs/workflow.md) first. In short: one issue per change, one branch per item, a pull request with independent review, and a squash merge.

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for details.
