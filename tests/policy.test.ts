import { describe, expect, test } from "bun:test";
import { errorPolicy, DEFAULT_LIMITS } from "../src/provider/policy";
import type { ErrorClass } from "../src/provider/types";

describe("errorPolicy (F-01)", () => {
  test("transient_rate_limit: retry_after até o limite, depois fallback", () => {
    for (let i = 1; i < DEFAULT_LIMITS.maxRateLimitRetries; i++) {
      expect(errorPolicy("transient_rate_limit", i)).toBe("retry_after");
    }
    expect(errorPolicy("transient_rate_limit", DEFAULT_LIMITS.maxRateLimitRetries)).toBe("fallback");
    expect(errorPolicy("transient_rate_limit", DEFAULT_LIMITS.maxRateLimitRetries + 1)).toBe("fallback");
  });

  test("outage: retry_backoff até o limite, depois fallback", () => {
    for (let i = 1; i < DEFAULT_LIMITS.maxOutageRetries; i++) {
      expect(errorPolicy("outage", i)).toBe("retry_backoff");
    }
    expect(errorPolicy("outage", DEFAULT_LIMITS.maxOutageRetries)).toBe("fallback");
    expect(errorPolicy("outage", DEFAULT_LIMITS.maxOutageRetries + 1)).toBe("fallback");
  });

  test("hard_quota: sempre skip (I-09)", () => {
    expect(errorPolicy("hard_quota", 1)).toBe("skip");
    expect(errorPolicy("hard_quota", 100)).toBe("skip");
  });

  test("auth: sempre abort", () => {
    expect(errorPolicy("auth", 1)).toBe("abort");
    expect(errorPolicy("auth", 100)).toBe("abort");
  });

  test("invalid_request: sempre abort", () => {
    expect(errorPolicy("invalid_request", 1)).toBe("abort");
    expect(errorPolicy("invalid_request", 100)).toBe("abort");
  });

  test("limites customizados", () => {
    expect(errorPolicy("transient_rate_limit", 3, { maxRateLimitRetries: 5 })).toBe("retry_after");
    expect(errorPolicy("transient_rate_limit", 5, { maxRateLimitRetries: 5 })).toBe("fallback");
    expect(errorPolicy("outage", 1, { maxOutageRetries: 1 })).toBe("fallback");
    expect(errorPolicy("outage", 1, { maxOutageRetries: 2 })).toBe("retry_backoff");
  });

  test("todas as 5 classes de D-18 cobertas", () => {
    const classes: ErrorClass[] = [
      "transient_rate_limit",
      "hard_quota",
      "auth",
      "outage",
      "invalid_request",
    ];
    for (const c of classes) {
      const action = errorPolicy(c, 1);
      expect(["retry_backoff", "retry_after", "skip", "fallback", "abort"]).toContain(action);
    }
  });
});
