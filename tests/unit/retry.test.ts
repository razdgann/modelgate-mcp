import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  networkErrorCode,
  parseRetryAfter,
  shouldRetryNetworkError,
  shouldRetryStatus,
} from "../../src/modelgate/retry.js";

const netErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

describe("retry policy", () => {
  it("reads retry transient statuses", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(shouldRetryStatus("idempotent", s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 413]) expect(shouldRetryStatus("idempotent", s)).toBe(false);
  });

  it("inference retries only 429 (never a possibly-billed 5xx)", () => {
    expect(shouldRetryStatus("inference", 429)).toBe(true);
    for (const s of [500, 502, 503, 504]) expect(shouldRetryStatus("inference", s)).toBe(false);
  });

  it("inference retries only pre-connection network errors", () => {
    expect(shouldRetryNetworkError("inference", netErr("ECONNREFUSED"))).toBe(true);
    expect(shouldRetryNetworkError("inference", netErr("ENOTFOUND"))).toBe(true);
    expect(shouldRetryNetworkError("inference", netErr("ECONNRESET"))).toBe(false);
    expect(shouldRetryNetworkError("inference", netErr("UND_ERR_SOCKET"))).toBe(false);
    expect(shouldRetryNetworkError("idempotent", netErr("ECONNRESET"))).toBe(true);
  });

  it("extracts nested error codes", () => {
    expect(networkErrorCode(netErr("EAI_AGAIN"))).toBe("EAI_AGAIN");
    expect(networkErrorCode(new Error("x"))).toBeUndefined();
  });

  it("uses bounded exponential backoff with full jitter", () => {
    expect(backoffDelayMs(0, undefined, () => 0.999)).toBeLessThan(500);
    expect(backoffDelayMs(3, undefined, () => 0.999)).toBeLessThan(4_000);
    expect(backoffDelayMs(20, undefined, () => 0.999)).toBeLessThanOrEqual(8_000);
    expect(backoffDelayMs(0, undefined, () => 0)).toBe(0);
  });

  it("honours Retry-After, capped at 30s", () => {
    expect(backoffDelayMs(0, 3)).toBe(3_000);
    expect(backoffDelayMs(0, 3_600)).toBe(30_000);
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
