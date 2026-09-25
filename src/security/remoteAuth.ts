import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HttpConfig } from "../config/config.js";

// Authentication for the remote (Streamable HTTP) transport. The remote
// server is never an unauthenticated inference proxy:
//   passthrough — the bearer token must be a ModelGate key (mg_…); requests
//                 run as that key, so ModelGate enforces its scopes and
//                 project boundary. The server holds no ModelGate credential.
//   token       — the bearer token must equal one of MODELGATE_MCP_AUTH_TOKENS
//                 (constant-time compare); requests run with MODELGATE_KEY.

const MG_KEY = /^mg_[A-Za-z0-9_-]{8,256}$/;

export type AuthOutcome =
  { ok: true; token: string; principal: string } | { ok: false; reason: "missing" | "malformed" | "invalid" };

/** Stable, non-reversible principal id (for rate limiting and logs). */
export function principalOf(secret: string): string {
  return `p_${createHash("sha256").update(secret).digest("hex").slice(0, 16)}`;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1];
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function authenticate(
  req: IncomingMessage,
  http: HttpConfig,
  serverKey: string | undefined,
): AuthOutcome {
  const token = bearerToken(req);
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > 512) return { ok: false, reason: "malformed" };
  if (http.authMode === "passthrough") {
    if (!MG_KEY.test(token)) return { ok: false, reason: "malformed" };
    return { ok: true, token, principal: principalOf(token) };
  }
  const presented = digest(token);
  let match = false;
  for (const t of http.authTokens) {
    // Compare fixed-length digests so neither length nor content leaks via timing.
    if (timingSafeEqual(presented, digest(t))) match = true;
  }
  if (!match || !serverKey) return { ok: false, reason: "invalid" };
  return { ok: true, token: serverKey, principal: principalOf(token) };
}
