import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { validateBaseUrl } from "../../src/security/baseUrl.js";
import { RateLimiter } from "../../src/security/rateLimit.js";
import { authenticate, principalOf } from "../../src/security/remoteAuth.js";

const req = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;
const KEY = "mg_cabc123def_" + "k".repeat(40);

describe("remote auth", () => {
  const passthrough = loadConfig({ mode: "http", env: {} }).http;
  const token = "T".repeat(48);
  const tokenCfg = loadConfig({
    mode: "http",
    env: {
      MODELGATE_MCP_AUTH: "token",
      MODELGATE_KEY: KEY,
      MODELGATE_MCP_AUTH_TOKENS: `${token},${"U".repeat(40)}`,
    },
  }).http;

  it("passthrough accepts only ModelGate keys and runs as that key", () => {
    expect(authenticate(req(), passthrough, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(authenticate(req("Basic abc"), passthrough, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(authenticate(req("Bearer not-a-key"), passthrough, undefined)).toEqual({
      ok: false,
      reason: "malformed",
    });
    const r = authenticate(req(`Bearer ${KEY}`), passthrough, undefined);
    expect(r).toMatchObject({ ok: true, token: KEY });
    if (r.ok) expect(r.principal).not.toContain(KEY);
  });

  it("token mode compares tokens and substitutes the server key", () => {
    expect(authenticate(req(`Bearer ${token}`), tokenCfg, KEY)).toMatchObject({ ok: true, token: KEY });
    expect(authenticate(req(`Bearer ${"U".repeat(40)}`), tokenCfg, KEY)).toMatchObject({ ok: true });
    expect(authenticate(req(`Bearer ${token}x`), tokenCfg, KEY)).toEqual({ ok: false, reason: "invalid" });
    // A ModelGate key is not an MCP auth token in token mode.
    expect(authenticate(req(`Bearer ${KEY}`), tokenCfg, KEY)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects absurdly long tokens", () => {
    expect(authenticate(req(`Bearer ${"a".repeat(600)}`), passthrough, undefined)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("principal ids are stable and non-reversible", () => {
    expect(principalOf(KEY)).toBe(principalOf(KEY));
    expect(principalOf(KEY)).toMatch(/^p_[0-9a-f]{16}$/);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, per key", () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1_000 });
    const t = 10_000;
    expect(rl.hit("a", t).allowed).toBe(true);
    expect(rl.hit("a", t).allowed).toBe(true);
    const third = rl.hit("a", t + 500);
    expect(third).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(rl.hit("b", t).allowed).toBe(true);
    expect(rl.hit("a", t + 1_000).allowed).toBe(true);
  });

  it("bounds memory", () => {
    const rl = new RateLimiter({ limit: 1, maxKeys: 10 });
    for (let i = 0; i < 1_000; i++) rl.hit(`k${i}`, 5);
    expect(rl.hit("k999", 5).allowed).toBe(false);
  });
});

describe("base URL", () => {
  it("allows https and loopback http only", () => {
    expect(validateBaseUrl("https://gw.modelgatehq.com")).toEqual({
      ok: true,
      origin: "https://gw.modelgatehq.com",
    });
    expect(validateBaseUrl("http://127.0.0.1:3001/v1")).toEqual({
      ok: true,
      origin: "http://127.0.0.1:3001",
    });
    expect(validateBaseUrl("http://169.254.169.254").ok).toBe(false);
    expect(validateBaseUrl("gopher://x").ok).toBe(false);
    expect(validateBaseUrl("javascript:alert(1)").ok).toBe(false);
  });
});
