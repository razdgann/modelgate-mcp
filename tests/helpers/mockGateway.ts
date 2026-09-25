import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the mock gateway received. */
export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  /** Resolves when the client closed the connection before the response finished. */
  aborted: Promise<boolean>;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export const KEY_A = "mg_projectAkey01_" + "a".repeat(43);
export const KEY_B = "mg_projectBkey02_" + "b".repeat(43);
export const KEY_SCOPED_MODELS = "mg_modelsonly03_" + "c".repeat(43);

export const COMPLETION = {
  id: "chatcmpl_test",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-mini",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello from ModelGate" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function sseHead(res: ServerResponse, requestId = "req-stream-1") {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-modelgate-request-id": requestId,
  });
}

export function chunk(content: string | null, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

export const USAGE_CHUNK = `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`;
export const DONE = "data: [DONE]\n\n";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * In-process stand-in for the ModelGate API. By default it behaves like the
 * real gateway for two projects (A, B) and a models-only scoped key; tests
 * override individual routes with `on()`.
 */
export class MockGateway {
  readonly requests: Recorded[] = [];
  #server: Server;
  #overrides = new Map<string, Handler>();
  url = "";

  constructor() {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    this.#server.closeAllConnections();
    await new Promise<void>((r) =>
      this.#server.close(() => {
        r();
      }),
    );
  }

  /** Override a route, keyed "METHOD /path". */
  on(route: string, handler: Handler): this {
    this.#overrides.set(route, handler);
    return this;
  }

  reset() {
    this.requests.length = 0;
    this.#overrides.clear();
  }

  last(path?: string): Recorded {
    const r = [...this.requests].reverse().find((x) => !path || x.path === path);
    if (!r) throw new Error(`no request to ${path ?? "any path"}`);
    return r;
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    let resolveAborted!: (v: boolean) => void;
    const aborted = new Promise<boolean>((r) => (resolveAborted = r));
    res.on("close", () => {
      resolveAborted(!res.writableFinished);
    });
    const rec: Recorded = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
      aborted,
    };
    this.requests.push(rec);
    const override = this.#overrides.get(`${rec.method} ${rec.path}`);
    if (override) return override(rec, res);
    this.#default(rec, res);
  }

  #default(req: Recorded, res: ServerResponse) {
    if (req.method === "GET" && req.path === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const project =
      auth === KEY_A ? "projA" : auth === KEY_B ? "projB" : auth === KEY_SCOPED_MODELS ? "projA" : null;
    const rid = `req-${this.requests.length}`;
    if (!project) {
      json(res, 401, { error: "invalid_api_key" }, { "x-modelgate-request-id": rid });
      return;
    }
    const scopes =
      auth === KEY_SCOPED_MODELS
        ? ["models:read"]
        : ["inference:write", "models:read", "usage:read", "requests:read"];
    const need = (s: string) => {
      if (scopes.includes(s)) return true;
      json(
        res,
        403,
        { error: "insufficient_scope", required_scope: s, message: "x" },
        { "x-modelgate-request-id": rid },
      );
      return false;
    };
    const route = `${req.method} ${req.path}`;
    if (route === "POST /v1/chat/completions") {
      if (!need("inference:write")) return;
      const body = req.body as { stream?: boolean };
      if (body.stream) {
        sseHead(res, rid);
        res.write(
          chunk(null, { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
        );
        res.write(chunk("Hel"));
        res.write(chunk("lo"));
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.write(USAGE_CHUNK);
        res.end(DONE);
        return;
      }
      json(res, 200, COMPLETION, { "x-modelgate-request-id": rid });
      return;
    }
    if (route === "GET /v1/models") {
      if (!need("models:read")) return;
      json(res, 200, {
        object: "list",
        data: [
          {
            id: "gpt-4o-mini",
            object: "model",
            owned_by: "openai",
            provider: "OPENAI",
            available: true,
            pricing: { currency: "USD", input_per_1m_tokens: "0.15", output_per_1m_tokens: "0.6" },
          },
          {
            id: "claude-haiku-4-5",
            object: "model",
            owned_by: "anthropic",
            provider: "ANTHROPIC",
            available: false,
            pricing: { currency: "USD", input_per_1m_tokens: "1", output_per_1m_tokens: "5" },
          },
        ],
        default_provider: "OPENAI",
        configured_providers: ["OPENAI"],
      });
      return;
    }
    if (route === "GET /v1/usage") {
      if (!need("usage:read")) return;
      json(res, 200, {
        object: "usage",
        project_id: project,
        from: req.query.get("from") ?? "2026-08-26T00:00:00.000Z",
        to: req.query.get("to") ?? "2026-09-25T00:00:00.000Z",
        filters: {
          model: req.query.get("model"),
          source: req.query.get("source"),
          provider: req.query.get("provider"),
        },
        totals: {
          requests: 3,
          input_tokens: 30,
          output_tokens: 20,
          total_tokens: 50,
          cost_usd: "0.000100",
          saved_usd: "0.000000",
          errors: 1,
          cache_hits: 0,
        },
        ...(req.query.get("group_by")
          ? {
              group_by: req.query.get("group_by"),
              groups: [
                { model: "gpt-4o-mini", source: "mcp", requests: 3, total_tokens: 50, cost_usd: "0.000100" },
              ],
            }
          : {}),
      });
      return;
    }
    if (req.method === "GET" && req.path.startsWith("/v1/requests/")) {
      if (!need("requests:read")) return;
      const id = decodeURIComponent(req.path.slice("/v1/requests/".length));
      // Tenant isolation as ModelGate implements it: other projects' ids are 404.
      if (!id.startsWith(project)) {
        json(res, 404, { error: "request_not_found" });
        return;
      }
      json(res, 200, {
        object: "request",
        id,
        status: "OK",
        provider: "OPENAI",
        model: "gpt-4o-mini",
        source: "mcp",
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        cost_usd: "0.0000066",
        latency_ms: 42,
        cache_hit: false,
        error: null,
        guard_events: [],
        reliability_incidents: [],
      });
      return;
    }
    if (route === "GET /v1/me") {
      json(res, 200, {
        object: "api_key",
        key: { id: `key-${project}`, name: "mcp" },
        project: { id: project, name: `${project} name` },
        scopes,
        legacy_full_access: false,
      });
      return;
    }
    json(res, 404, { message: `Route ${route} not found`, error: "Not Found", statusCode: 404 });
  }
}
