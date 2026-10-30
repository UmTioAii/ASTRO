import { expect, test } from "bun:test";
import { classifyProviderCheck } from "../src/tui/health";

test("classifica o check de health na taxonomia de erro do provider", () => {
  expect(classifyProviderCheck({ name: "provider:p", status: "ok", latencyMs: 5 })).toBeUndefined();
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "defina OPENAI_API_KEY no ambiente" })).toBe("auth");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 401 em GET /models" })).toBe("auth");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 403 em GET /models" })).toBe("auth");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 404 em GET /models" })).toBe("invalid_request");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 429 em GET /models" })).toBe("transient_rate_limit");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "HTTP 500 em GET /models" })).toBe("outage");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "timeout de 5000ms" })).toBe("outage");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "Unable to connect" })).toBe("outage");
  expect(classifyProviderCheck({ name: "provider:p", status: "down", detail: "ENOENT: no such file" })).toBe("auth");
});
