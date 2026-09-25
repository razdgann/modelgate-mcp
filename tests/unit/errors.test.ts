import { describe, expect, it } from "vitest";
import { ModelGateMcpError } from "../../src/errors/errors.js";
import { errorFromResponse } from "../../src/errors/map.js";
import { normalizeError, toolErrorResult } from "../../src/errors/toolResult.js";
import { silentLogger } from "../../src/logging/logger.js";

const map = (status: number, body: unknown, extra: Partial<Parameters<typeof errorFromResponse>[0]> = {}) =>
  errorFromResponse({ status, body, path: "/v1/chat/completions", requestId: "rid-1", ...extra });

describe("errorFromResponse", () => {
  it.each([
    [
      400,
      { error: "bad_request", details: { fieldErrors: { model: ["Required"] } } },
      "invalid_request",
      false,
    ],
    [400, { error: "provider_required" }, "provider_required", false],
    [400, { error: "provider_not_configured", provider: "ANTHROPIC" }, "provider_not_configured", false],
    [401, { error: "invalid_api_key" }, "auth_invalid", false],
    [402, { error: "monthly_quota_exceeded" }, "quota_exceeded", false],
    [403, { error: "insufficient_scope", required_scope: "usage:read" }, "insufficient_scope", false],
    [
      403,
      { error: "blocked_by_guardrails", category: "prompt_injection", score: 91 },
      "guardrail_blocked",
      false,
    ],
    [404, { error: "request_not_found" }, "not_found", false],
    [404, { message: "Route GET:/v1/models not found" }, "endpoint_unavailable", false],
    [409, { error: "stream_enforce_conflict" }, "stream_unavailable", false],
    [413, { error: "prompt_too_large" }, "payload_too_large", false],
    [429, { error: "rate_limited" }, "rate_limited", true],
    [499, {}, "cancelled", false],
    [500, { error: "internal_error" }, "gateway_error", true],
    [502, { error: "provider_error", provider_status: 404, retryable: false }, "invalid_model", false],
    [502, { error: "provider_error", provider_status: 504, retryable: true }, "provider_timeout", true],
    [502, { error: "provider_error", provider_status: 503, retryable: true }, "provider_error", true],
    [502, { error: "provider_error", provider_status: 401, retryable: false }, "provider_error", false],
    [502, "<html>bad gateway</html>", "gateway_error", true],
    [504, undefined, "gateway_timeout", true],
  ])("%i %j → %s", (status, body, code, retryable) => {
    const e = map(status, body);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.requestId).toBe("rid-1");
    expect(e.status).toBe(status);
  });

  it("carries the required scope and guardrail details", () => {
    expect(map(403, { error: "insufficient_scope", required_scope: "usage:read" }).details).toEqual({
      required_scope: "usage:read",
    });
    expect(
      map(403, { error: "blocked_by_guardrails", category: "prompt_injection", score: 91 }).message,
    ).toMatch(/risk score 91/);
    expect(map(400, { error: "bad_request", details: { fieldErrors: { model: ["x"] } } }).message).toMatch(
      /model/,
    );
  });

  it("never copies arbitrary upstream body text into the error", () => {
    const e = map(500, { error: "internal_error", message: "db password=hunter2", stack: "at x" });
    expect(JSON.stringify(e.toJSON())).not.toMatch(/hunter2|stack/);
    const e2 = map(403, { error: "blocked_by_guardrails", category: "<script>alert(1)</script>" });
    expect(e2.message).not.toContain("<script>");
  });

  it("includes retry-after", () => {
    const e = map(429, { error: "rate_limited" }, { retryAfterSeconds: 7 });
    expect(e.retryAfterSeconds).toBe(7);
    expect(e.toJSON()).toMatchObject({ retry_after_seconds: 7, retryable: true });
  });
});

describe("tool error results", () => {
  it("turns unknown errors into opaque internal_error", () => {
    const e = normalizeError(new Error("secret internals mg_cid_abcdefgh123"), silentLogger);
    expect(e.code).toBe("internal_error");
    expect(e.message).not.toContain("internals");
  });

  it("renders a sanitized isError result with code, request id and retryability", () => {
    const r = toolErrorResult(
      new ModelGateMcpError("rate_limited", "slow down", { retryable: true, requestId: "rid-9" }),
    );
    expect(r.isError).toBe(true);
    const txt = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(txt).toContain("[rate_limited]");
    expect(txt).toContain("rid-9");
    expect(txt).toContain("Retryable: yes");
    expect(txt).not.toMatch(/at .*\.ts:\d+/);
  });

  it("scrubs secrets from error messages", () => {
    const e = new ModelGateMcpError("internal_error", "leak Bearer mg_cid_abcdefgh123 here");
    expect(e.message).not.toContain("abcdefgh123");
  });
});
