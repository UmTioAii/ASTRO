import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { Metrics, MetricsCollector, startMetricsServer } from "../src/metrics";

function wiredPair() {
  const metrics = new Metrics();
  const collector = new MetricsCollector(metrics);
  const dir = mkdtempSync(join(tmpdir(), "astro-metrics-"));
  const audit = new Auditor(join(dir, "audit.jsonl"), { onEvent: collector.onAuditEvent });
  const ledger = new Ledger(join(dir, "ledger.jsonl"), {
    warn: () => {},
    onRecord: collector.onLedgerRecord,
  });
  return { metrics, audit, ledger };
}

/** Simula os eventos exatos que um run real produz. */
function simulateRun(audit: Auditor, ledger: Ledger): void {
  audit.append({ run: "r1", agent: "coder", tipo: "run.started", payload: {} });
  audit.append({ run: "r1", agent: "coder", tipo: "tool.call", payload: { name: "write_file" } });
  audit.append({ run: "r1", agent: "coder", tipo: "tool.result", payload: { name: "write_file", isError: false } });
  ledger.record(
    { run: "r1", agent: "coder", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 100, tokensOut: 50 },
    { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: true },
  );
  audit.append({ run: "r1", agent: "coder", tipo: "run.completed", payload: { steps: 1 } });
}

describe("metrics Prometheus (F6-1)", () => {
  test("contadores acumulam a partir dos eventos de auditoria e ledger", () => {
    const { metrics, audit, ledger } = wiredPair();
    simulateRun(audit, ledger);

    const text = metrics.render();
    expect(text).toContain("# TYPE astro_runs_total counter");
    expect(text).toContain('astro_runs_total{agent="coder",status="ok"} 1');
    expect(text).toContain('astro_tokens_total{direction="in",model="gpt-4o-mini",provider="openai"} 100');
    expect(text).toContain('astro_tokens_total{direction="out",model="gpt-4o-mini",provider="openai"} 50');
    // custo: 100/1e6*1 + 50/1e6*2 = 0.0002
    expect(text).toContain('astro_cost_usd_total{model="gpt-4o-mini",provider="openai"} 0.0002');
    expect(text).toContain("# TYPE astro_step_duration_seconds_count counter");
    expect(text).toContain('astro_step_duration_seconds_count{agent="coder",tool="write_file"} 1');
  });

  test("run.stopped conta como error", () => {
    const { metrics, audit } = wiredPair();
    audit.append({ run: "r1", agent: "coder", tipo: "run.stopped", payload: { reason: "max_steps" } });
    expect(metrics.render()).toContain('astro_runs_total{agent="coder",status="error"} 1');
  });

  test("costUsd null não incrementa custo", () => {
    const { metrics, ledger } = wiredPair();
    ledger.record(
      { run: "r1", agent: "a", provider: "x", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 10, tokensOut: 5 },
      undefined,
    );
    expect(metrics.render()).not.toContain("astro_cost_usd_total");
  });

  test("incError por classe (D-18)", () => {
    const metrics = new Metrics();
    metrics.incError("openai", "gpt-4o-mini", "transient_rate_limit");
    const text = metrics.render();
    expect(text).toContain('astro_errors_total{class="transient_rate_limit",model="gpt-4o-mini",provider="openai"} 1');
  });

  test("/metrics via HTTP mostra contadores após run", async () => {
    const { metrics, audit, ledger } = wiredPair();
    simulateRun(audit, ledger);
    const handle = startMetricsServer(metrics, 0); // porta aleatória
    try {
      const response = await fetch(`${handle.url}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const body = await response.text();
      expect(body).toContain('astro_runs_total{agent="coder",status="ok"} 1');
      expect(body).toContain('astro_tokens_total{direction="in"');

      // rota desconhecida → 404
      const notFound = await fetch(`${handle.url}/other`);
      expect(notFound.status).toBe(404);
    } finally {
      handle.stop();
    }
  });

  test("registro vazio renderiza string vazia", () => {
    expect(new Metrics().render()).toBe("");
  });
});