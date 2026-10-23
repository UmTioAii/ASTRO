import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { CompletionResponse, Provider } from "../src/provider/types";
import type { ModelEntry } from "../src/registry";
import { runSession, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";
import { writeFileTool } from "../src/tools/write-file";
import { OtlpTracer, tracerFromEnv, type SpanHandle } from "../src/tracing";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

/** Coletor OTLP mock: registra os POSTs recebidos em /v1/traces. */
function otlpCollector(): { url: string; posts: Array<Record<string, unknown>>; stop: () => void } {
  const posts: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      if (request.method === "POST") {
        posts.push(JSON.parse(await request.text()) as Record<string, unknown>);
      }
      return new Response("{}", { status: 200 });
    },
  });
  return { url: `http://localhost:${server.port}`, posts, stop: () => server.stop(true) };
}

describe("tracing OTLP (F6-2)", () => {
  test("tracerFromEnv: sem endpoint → undefined; com endpoint → tracer", () => {
    expect(tracerFromEnv({})).toBeUndefined();
    expect(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).toBeUndefined();
    const t = tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(t).toBeInstanceOf(OtlpTracer);
  });

  test("hierarquia de spans: run → step → provider.complete + tool.exec", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-trace-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"), { warn: () => {} });
    const tracer = new OtlpTracer("http://collector.invalid"); // export falha silenciosamente

    let step = 0;
    const provider: Provider = {
      complete: async () => {
        step++;
        if (step === 1) {
          return resp({ toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] });
        }
        return resp({ content: "pronto" });
      },
    };

    const opts: SessionOptions = {
      run: "r1", agent: "coder", credentialRef: "K", quotaDomain: "d",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [writeFileTool], allow: ["write_file"], audit }),
      ledger, audit, maxSteps: 5, tracer,
    };

    const result = await runSession(opts, "crie a.txt");
    expect(result.final).toBe("pronto");

    const spans = tracer.recorded();
    const names = spans.map((s) => s.name);
    expect(names).toContain("run");
    expect(names).toContain("step");
    expect(names).toContain("provider.complete");
    expect(names).toContain("tool.exec");

    // hierarquia: todos do mesmo trace; step tem parent = run; tool tem parent = step
    const run = spans.find((s) => s.name === "run")!;
    const stepSpan = spans.find((s) => s.name === "step")!;
    const providerSpan = spans.find((s) => s.name === "provider.complete")!;
    const toolSpan = spans.find((s) => s.name === "tool.exec")!;
    expect(stepSpan.parentSpanId).toBe(run.spanId);
    expect(providerSpan.parentSpanId).toBe(stepSpan.spanId);
    expect(toolSpan.parentSpanId).toBe(stepSpan.spanId);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);

    // atributos
    const attr = (s: (typeof spans)[number], key: string): string | number | boolean | undefined =>
      s.attributes.find((a) => a.key === key)?.value.stringValue ??
      s.attributes.find((a) => a.key === key)?.value.intValue ??
      s.attributes.find((a) => a.key === key)?.value.boolValue;
    expect(attr(run, "agent")).toBe("coder");
    expect(attr(run, "status")).toBe("ok");
    expect(attr(stepSpan, "step")).toBe(1);
    expect(attr(providerSpan, "model")).toBe("gpt-4o-mini");
    expect(attr(toolSpan, "tool")).toBe("write_file");
    expect(attr(toolSpan, "isError")).toBe(false);
  });

  test("export OTLP/HTTP: POST em /v1/traces ao fim do span raiz", async () => {
    const collector = otlpCollector();
    try {
      const tracer = new OtlpTracer(collector.url);

      const root = tracer.start("run", { agent: "coder" }) as SpanHandle;
      const child = tracer.start("step", { step: 1 }, root) as SpanHandle;
      tracer.end(child);
      tracer.end(root, { status: "ok" });

      // export é async fire-and-forget; espera breve
      await new Promise((r) => setTimeout(r, 50));
      expect(collector.posts.length).toBeGreaterThanOrEqual(1);
      const body = collector.posts[0] as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
          scopeSpans: Array<{ spans: Array<{ name: string; parentSpanId?: string }> }>;
        }>;
      };
      expect(body.resourceSpans[0]!.resource.attributes[0]!.key).toBe("service.name");
      expect(body.resourceSpans[0]!.resource.attributes[0]!.value.stringValue).toBe("astro");
      const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
      expect(spans.map((s) => s.name).sort()).toEqual(["run", "step"]);
      // child referencia o root
      expect(spans.find((s) => s.name === "step")!.parentSpanId).toBe(root.spanId);
    } finally {
      collector.stop();
    }
  });

  test("sem tracer: sessão funciona idêntica (zero custo quando ausente)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-trace-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"), { warn: () => {} });
    const provider: Provider = { complete: async () => resp({ content: "ok" }) };
    const opts: SessionOptions = {
      run: "r1", agent: "a", credentialRef: "K", quotaDomain: "d",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [], allow: [], audit }),
      ledger, audit, maxSteps: 3,
    };
    const result = await runSession(opts, "tarefa");
    expect(result.final).toBe("ok");
  });

  test("endpoint fora do ar: export falha em silêncio, spans gravados", async () => {
    const tracer = new OtlpTracer("http://dead.local:1");
    const root = tracer.start("run", {}) as SpanHandle;
    tracer.end(root);
    await new Promise((r) => setTimeout(r, 30));
    expect(tracer.recorded()).toHaveLength(1);
  });
});