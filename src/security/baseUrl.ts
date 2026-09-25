// Validation for MODELGATE_BASE_URL.
//
// The base URL decides where the ModelGate API key is sent, so it is treated
// as security-sensitive configuration:
//   - https only (plain http is allowed for loopback development servers);
//   - no embedded credentials, query string, or fragment;
//   - no path beyond an optional "/v1" (which is stripped, so both
//     https://gw.modelgatehq.com and https://gw.modelgatehq.com/v1 work);
//   - in remote (HTTP) mode a non-default origin must be explicitly allowed
//     with MODELGATE_ALLOW_CUSTOM_BASE_URL=true.
// The URL is operator configuration only — no MCP request can change it, and
// the HTTP client refuses redirects so a key is never forwarded elsewhere.

export const DEFAULT_BASE_URL = "https://gw.modelgatehq.com";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export type BaseUrlResult = { ok: true; origin: string } | { ok: false; problem: string };

export function validateBaseUrl(raw: string): BaseUrlResult {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      problem: "MODELGATE_BASE_URL is not a valid URL (expected e.g. https://gw.modelgatehq.com)",
    };
  }
  if (url.username || url.password) {
    return { ok: false, problem: "MODELGATE_BASE_URL must not contain credentials" };
  }
  if (url.search || url.hash) {
    return { ok: false, problem: "MODELGATE_BASE_URL must not contain a query string or fragment" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    return {
      ok: false,
      problem: "MODELGATE_BASE_URL must use https:// (http:// is only allowed for localhost development)",
    };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/v1") {
    return {
      ok: false,
      problem: `MODELGATE_BASE_URL must be the gateway origin (e.g. ${DEFAULT_BASE_URL}), not a path`,
    };
  }
  return { ok: true, origin: url.origin };
}
