/**
 * Tracing OpenTelemetry (F6-2): spans run → step → provider.complete/tool.exec
 * exportados via OTLP/HTTP JSON (fetch puro, zero dependências). Habilitado
 * quando OTEL_EXPORTER_OTLP_ENDPOINT está no ambiente; falha de export é silenciosa.
 */
import { randomBytes } from "node:crypto";

export type SpanValue = string | number | boolean;

/** Handle opaco de span, manipulado só pelo tracer que o criou. */
export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

export interface TracerLike {
  start(name: string, attrs: Record<string, SpanValue>, parent?: SpanHandle | undefined): SpanHandle | undefined;
  end(span: SpanHandle | undefined, attrs?: Record<string, SpanValue>): void;
}

interface SpanRecord extends SpanHandle {
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { [k: string]: SpanValue } }>;
}

function toAttributeValue(value: SpanValue): { [k: string]: SpanValue } {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  return { boolValue: value };
}

/** Tracer OTLP/HTTP: acumula spans e exporta no fim do span raiz. */
export class OtlpTracer implements TracerLike {
  readonly #endpoint: string;
  readonly #fetchLike: typeof fetch;
  readonly #spans = new Map<string, SpanRecord>();
  readonly #roots = new Set<string>();
  readonly #serviceName: string;

  constructor(endpoint: string, opts?: { fetchLike?: typeof fetch; serviceName?: string }) {
    this.#endpoint = endpoint.replace(/\/$/, "");
    this.#fetchLike = opts?.fetchLike ?? fetch;
    this.#serviceName = opts?.serviceName ?? "astro";
  }

  start(name: string, attrs: Record<string, SpanValue>, parent?: SpanHandle | undefined): SpanHandle | undefined {
    const traceId = parent?.traceId ?? randomBytes(16).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const handle: SpanHandle = {
      traceId,
      spanId,
      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
    };
    this.#spans.set(spanId, {
      ...handle,
      name,
      kind: 1, // INTERNAL
      startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
      endTimeUnixNano: "0",
      attributes: Object.entries(attrs).map(([key, value]) => ({
        key,
        value: toAttributeValue(value),
      })),
    });
    if (parent === undefined) this.#roots.add(traceId);
    return handle;
  }

  end(span: SpanHandle | undefined, attrs?: Record<string, SpanValue>): void {
    if (span === undefined) return;
    const record = this.#spans.get(span.spanId);
    if (record === undefined) return;
    record.endTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
    if (attrs !== undefined) {
      for (const [key, value] of Object.entries(attrs)) {
        record.attributes.push({ key, value: toAttributeValue(value) });
      }
    }
    // Fim do span raiz dispara o export do trace completo
    if (this.#roots.has(span.traceId)) {
      void this.#export(span.traceId);
    }
  }

  /** Spans gravados (para inspeção em testes). */
  recorded(): SpanRecord[] {
    return [...this.#spans.values()];
  }

  async #export(traceId: string): Promise<void> {
    try {
      const spans = [...this.#spans.values()].filter((s) => s.traceId === traceId);
      if (spans.length === 0) return;
      const body = {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: this.#serviceName } }],
            },
            scopeSpans: [
              {
                scope: { name: "astro" },
                spans: spans.map((s) => ({
                  traceId: s.traceId,
                  spanId: s.spanId,
                  ...(s.parentSpanId === undefined ? {} : { parentSpanId: s.parentSpanId }),
                  name: s.name,
                  kind: s.kind,
                  startTimeUnixNano: s.startTimeUnixNano,
                  endTimeUnixNano: s.endTimeUnixNano,
                  status: { code: 1 },
                  attributes: s.attributes,
                })),
              },
            ],
          },
        ],
      };
      await this.#fetchLike(`${this.#endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // export é best-effort; tracing nunca quebra o run
    }
  }
}

/** Devolve um tracer quando OTEL_EXPORTER_OTLP_ENDPOINT está definido. */
export function tracerFromEnv(env: Record<string, string | undefined>): OtlpTracer | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint.length === 0) return undefined;
  return new OtlpTracer(endpoint);
}