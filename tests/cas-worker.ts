// Processo filho do teste de concorrência real (F-26): grava um handoff.created
// no ledger informado e imprime o handoff_id devolvido pelo CAS.
import { Ledger } from "../src/ledger";
import { buildHandoffArtifact, type HandoffDraft } from "../src/handoff/types";

const [ledgerPath, run] = process.argv.slice(2) as [string, string];
const draft: HandoffDraft = { task: "via única", objective: "um único created", decisions: [], constraints: [], next_steps: [] };
const artifact = buildHandoffArtifact({ run, from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 }, draft });
const entry = new Ledger(ledgerPath).recordHandoff("handoff.created", run, artifact, { agent: "planner" });
console.log(entry.handoff_id);
