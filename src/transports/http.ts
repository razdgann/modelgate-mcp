import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
} from "@modelcontextprotocol/node";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { ModelGateMcpConfig } from "../config/config.js";
import { ModelGateMcpError } from "../errors/errors.js";
import type { Logger } from "../logging/logger.js";
import { getMe } from "../modelgate/api.js";
import { ModelGateClient, type FetchFn } from "../modelgate/client.js";
import { authenticate, principalOf } from "../security/remoteAuth.js";
import { RateLimiter } from "../security/rateLimit.js";
import { createServerFactory } from "../server.js";
import { PACKAGE_NAME, VERSION } from "../version.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

const MAX_IN_FLIGHT = 256;
const AUTH_FAILURES_PER_MINUTE = 30;

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Remote MCP over Streamable HTTP (MCP spec 2026-07-28, with the SDK's
 * stateless fallback for 2025-era clients). Stateless: one server instance
 * per request, nothing shared between callers except the rate limiter.
 *
 * Request pipeline for POST/GET/DELETE /mcp:
 *   Host check (DNS rebinding) → Origin check → bearer auth → key check
 *   (passthrough) → per-principal rate limit → in-flight cap → MCP handler.
 */
export async function startHttp(
  config: ModelGateMcpConfig,
  logger: Logger,
  options: { fetch?: FetchFn } = {},
): Promise<RunningHttpServer> {
  const http = config.http;
  const factory = createServerFactory({
    config,
    logger,
    transport: "http",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const handler = createMcpHandler(factory, {
    maxRequestBodySize: http.maxBodyBytes,
    onerror: (error) => {
      logger.warn("mcp handler error", { error });
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: http.maxBodyBytes,
    onerror: (error) => {
      logger.error("mcp adapter error", { error });
    },
  });
  const validateHost = hostHeaderValidation(http.allowedHosts);
  const validateOrigin = originValidation(http.allowedOrigins);
  const limiter = new RateLimiter({ limit: http.rateLimitPerMinute });
  const failureLimiter = new RateLimiter({ limit: AUTH_FAILURES_PER_MINUTE });
  const keyCheck = new KeyVerifier(config, logger, options.fetch);
  let inFlight = 0;

  const server: Server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      logger.error("http request failed", { error });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    const path = (req.url ?? "/").split("?")[0];

    if (path === HEALTH_PATH && (req.method === "GET" || req.method === "HEAD")) {
      sendJson(res, 200, { ok: true, name: PACKAGE_NAME, version: VERSION });
      return;
    }
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const ip = req.socket.remoteAddress ?? "unknown";
    const auth = authenticate(req, http, config.apiKey);
    if (!auth.ok) {
      const limited = failureLimiter.hit(`ip:${ip}`);
      if (!limited.allowed) {
        tooMany(res, limited.retryAfterSeconds);
        return;
      }
      logger.info("rejected unauthenticated request", { reason: auth.reason });
      unauthorized(res, auth.reason === "missing" ? "Missing bearer token" : "Invalid bearer token");
      return;
    }

    const rl = limiter.hit(auth.principal);
    if (!rl.allowed) {
      tooMany(res, rl.retryAfterSeconds);
      return;
    }

    if (http.authMode === "passthrough") {
      const verdict = await keyCheck.verify(auth.token);
      if (verdict === "invalid") {
        failureLimiter.hit(`ip:${ip}`);
        unauthorized(res, "ModelGate rejected this API key");
        return;
      }
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      res.setHeader("retry-after", "1");
      sendJson(res, 503, { error: "server_busy" });
      return;
    }
    inFlight++;
    res.once("close", () => {
      inFlight--;
    });
    const authInfo: AuthInfo = { token: auth.token, clientId: auth.principal, scopes: [] };
    // toNodeHandler forwards `req.auth` as the handler's pass-through authInfo.
    // Node always sets method/url on server requests; the SDK type just says so.
    const nodeReq = req as unknown as NodeIncomingMessageLike & { auth?: AuthInfo };
    nodeReq.auth = authInfo;
    await nodeHandler(nodeReq, res);
  }

  // Bound how long a client may take to *send* a request (headers 30 s, whole
  // request 60 s: slowloris protection). These do not limit response time, so
  // long streamed generations are unaffected; those are bounded per call by
  // MODELGATE_TIMEOUT_MS and the stream idle timeout.
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(http.port, http.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  const url = `http://${host}:${addr.port}${MCP_PATH}`;
  logger.info("modelgate-mcp listening on streamable HTTP", {
    url,
    auth_mode: http.authMode,
    base_url: config.baseUrl,
    allowed_hosts: http.allowedHosts,
  });

  let closing: Promise<void> | undefined;
  return {
    url,
    close: () =>
      (closing ??= (async () => {
        const closed = new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
        server.closeIdleConnections();
        await handler.close().catch(() => undefined);
        const force = setTimeout(() => {
          server.closeAllConnections();
        }, 10_000);
        await closed;
        clearTimeout(force);
        logger.info("modelgate-mcp http server stopped");
      })()),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse, message: string) {
  res.setHeader("www-authenticate", 'Bearer realm="modelgate-mcp", error="invalid_token"');
  sendJson(res, 401, { error: "unauthorized", message });
}

function tooMany(res: ServerResponse, retryAfter: number) {
  res.setHeader("retry-after", String(retryAfter));
  sendJson(res, 429, { error: "rate_limited" });
}

/**
 * Passthrough mode: confirm a presented key with ModelGate (GET /v1/me)
 * before serving it, so the remote server never relays traffic for keys
 * ModelGate rejects and clients get a proper HTTP 401. Verdicts are cached
 * briefly (valid 5 min, invalid 30 s; bounded size) keyed by a hash, never
 * the key. Deployments without /v1/me fall back to "unknown" (served; the
 * gateway still rejects bad keys on every call).
 */
class KeyVerifier {
  readonly #cache = new Map<string, { verdict: "valid" | "invalid" | "unknown"; until: number }>();
  constructor(
    private readonly config: ModelGateMcpConfig,
    private readonly logger: Logger,
    private readonly fetchFn: FetchFn | undefined,
  ) {}

  async verify(key: string): Promise<"valid" | "invalid" | "unknown"> {
    const id = principalOf(key);
    const now = Date.now();
    const hit = this.#cache.get(id);
    if (hit && hit.until > now) return hit.verdict;
    let verdict: "valid" | "invalid" | "unknown";
    try {
      const client = new ModelGateClient({
        baseUrl: this.config.baseUrl,
        apiKey: key,
        timeoutMs: Math.min(this.config.timeoutMs, 15_000),
        maxRetries: 1,
        logger: this.logger,
        ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
      });
      await getMe(client, {});
      verdict = "valid";
    } catch (err) {
      verdict = err instanceof ModelGateMcpError && err.code === "auth_invalid" ? "invalid" : "unknown";
    }
    if (this.#cache.size >= 5_000) this.#cache.clear();
    this.#cache.set(id, { verdict, until: now + (verdict === "valid" ? 300_000 : 30_000) });
    return verdict;
  }
}
