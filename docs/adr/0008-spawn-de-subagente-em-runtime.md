# ADR-0008: spawn de subagente em runtime com teto, ciclo de vida e kind `agent`

- Status: aceita
- Data: 2026-10-28
- Issue: #119
- Decisões relacionadas: D-07, D-10, ADR-0006, ADR-0007, ADR-0009

## Contexto

Hoje "a LLM nunca cria agente em runtime" (`src/agent-manager.ts:15`): só existem agents declarados na config. Isso trava a delegação dinâmica por `need` (C4a, #128). A troca dessa regra não pode abrir bypass de allowlist (I-01), escopo maior que o do pai (I-02), canal p2p (I-18) nem placement irreproduzível (I-06).

## Decisão

**Tools (A1).** A LLM ganha exatamente duas, ambas sob a allowlist como qualquer tool (I-01): `list_model_candidates({need, requires?})` devolve o snapshot ranqueado de candidatos da pool; `spawn_agent({need, task, model?, reason?, tools?, maxTurns?, snapshot_id?})` devolve `{agent_id, model, profile, status: "active"}`, com profile derivado do modelo pela pool (ADR-0007), fixado no spawn. Códigos: `invalid_need` (need fora do vocabulário declarado), `invalid_model_choice` (modelo fora do snapshot, ou tentativa de passar provider/credentialRef/profile fora da pool/parâmetros de chamada — A3), `candidate_set_changed` (snapshot diverge da pool atual), `no_candidates` (snapshot vazio), `spawn_limit_exceeded` (teto de A2), `spawn_unavailable` (tool chamada no caminho single/chat), `account_locked` (conta já presa), `default_rank` (sem `model`, rank 1 do snapshot é a escolha registrada). Ranking e snapshot são do ADR-0011 (#120).

**Tetos (A2, Q-02).** `agents.maxActive` é o teto efetivo; v1 usa o declarado ou o default 2 (orchestrator + um subagente), aplicado pelo lock de conta. O teto de spawns por run é fixo em 8 na v1 (não é chave de config). Na carga da config, `maxActive <= contas (credenciais) declaradas` (v1: `2 <= contas`); fora disso `loadConfig` falha com `max_active_exceeds_accounts`. Cada agente ativo consome conta exclusiva (ADR-0009).

**Escolha do modelo (A3).** A LLM só escolhe dentro do snapshot devolvido por `list_model_candidates`; nunca define provider, `credentialRef`, profile fora da pool nem parâmetros de chamada.

**Ciclo de vida e kind `agent` (A5, PS-5).** O ledger ganha o kind `agent` (aditivo, D-10): `event` (`created`|`destroyed`|`identity`), `agent_id`, `parent_agent_id`, `session_id`, `need`, `model`, `provider`, `credentialRef`, `profile`, `reason` (na destruição, a causa: loop sem tool call, `maxTurns`, orchestrator (S-10, #127) ou `crash_recovered` do ADR-0009). Ordem do destroy: ledger `agent.destroyed` → audit `agent.destroyed` (padrão do `AgentManager`) → liberar lock — a própria escrita do `agent.destroyed` (ADR-0009), sem segundo mecanismo → parar chamadas → persistir histórico (PS-2).

**Herança e comunicação (A10, A8/A9).** Subagente NÃO herda o profile do pai; herda teto: `tools?` ⊆ allowlist do pai, `maxTurns?` e orçamento nunca maiores que os dele (I-02). Recebe `HandoffArtifactV1` (ADR-0006) com a task + `AGENTS.md`, nunca mensagens do orchestrator nem histórico da sessão (A9); comunicação só via handoff do orchestrator (I-18), sem canal p2p.

**Serial em v1 (A11, Q-12).** Um subagente por vez; paralelo é v2. Testes usam `maxActive=2`. O entryAgent default continua `planner` (Q-03).

**Emendas.** I-01 estende-se a agents nascidos em runtime: a declaração efetiva do subagente (tools, teto, orçamento, sandbox) deriva do `spawn_agent` e é sempre ⊆ à do pai; nada fora dela é acessível. I-06 estende a reprodução ao runtime: `snapshot_id` + escolha registrada no ledger reproduzem o placement; `candidate_set_changed` detecta divergência (composição com ADR-0011, #120). Para subagentes nascidos em runtime, esta decisão substitui a cláusula "a LLM nunca escolhe modelo em runtime" do ADR-0007, que segue valendo para agents declarados na config; a auditabilidade exigida lá é preservada por `snapshot_id` + escolha registrada no ledger (I-06).

**Implementação (S-11, #128).** `src/spawn.ts` registra o filho, adquire a conta (A4), fixa modelo/profile/tools/teto e devolve `{agent_id, model, profile, status:"active"}`; o handoff executa o filho em série. `maxSpawnsPerRun` fixo em 8, `maxActive` efetivo 2, tools ⊆ pai, `maxTurns` ≤ pai, comunicação só com o pai (A8), filho não spawna neto na v1 e limpeza dos filhos ao fim do run (A5). O filho recebe task + `AGENTS.md` no system prompt, sem o histórico do orchestrator (A9). No caminho single/chat a tool responde `spawn_unavailable` antes de adquirir conta.

## Consequências

- Ganho: delegação dinâmica auditável, com teto, sem bypass de escopo e reproduzível.
- Custo: S-11 (#128) implementa as tools; `loadConfig` valida contas; `AgentManager` estende o ciclo com o kind `agent`.
- Invariantes afetadas: I-01 e I-06 emendadas (acima); I-02 mantida via teto herdado; I-18 intocada.

## Alternativas descartadas

- Manter "LLM nunca cria agente em runtime": trava C4a (#128) e a escalada de esforço da trilha.
- Spawn herdando o profile do pai: contradiz A10 e o per-fallback do ADR-0007.
- Canal p2p entre subagentes: escapa do orchestrator; viola I-18.
- Paralelismo em v1: sem baseline de custo por conta; Q-12 defere para v2.
