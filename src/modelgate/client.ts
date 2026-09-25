import { ModelGateMcpError } from "../errors/errors.js";
import { errorFromResponse } from "../errors/map.js";
import type { Logger } from "../logging/logger.js";
import { userAgent } from "./attribution.js";
import {
  backoffDelayMs,
  networkErrorCode,
  parseRetryAfter,
  shouldRetryNetworkError,
  shouldRetryStatus,
  sleep,
  type RetryClass,
} from "./retry.js";
import { parseSse } from "./sse.js";

export const REQUEST_ID_HEADER = "x-modelgate-request-id";

const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface ModelGateClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  logger: Logger;
  fetch?: FetchFn;
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
  headers?: Record<string, string> | undefined;
}

export interface JsonResult {
  data: unknown;
  requestId: string | undefined;
  status: number;
}

export interface StreamResult {
  requestId: string | undefined;
  /** SSE `data:` payloads. Iterating to completion (or breaking) releases the connection. */
  events: AsyncGenerator<string>;
}

/**
 * Minimal HTTP client for the ModelGate API. It owns transport concerns only —
 * auth header, attribution headers passed in by callers, timeouts,
 * cancellation, bounded bodies, retries per retry.ts — and holds no business
 * logic. One instance per credential: in remote passthrough mode each MCP
 * request gets a client bound to that caller's own key.
 */
export class ModelGateClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #logger: Logger;
  readonly #fetch: FetchFn;

  constructor(options: ModelGateClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#maxRetries = options.maxRetries;
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async getJson(
    path: string,
    query: Record<string, string | undefined> = {},
    options: CallOptions = {},
  ): Promise<JsonResult> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
    const url = `${path}${qs.size ? `?${qs.toString()}` : ""}`;
    const res = await this.#send("GET", url, undefined, "idempotent", options, "application/json");
    try {
      return {
        data: await readJson(res.response, res.classify),
        requestId: res.requestId,
        status: res.response.status,
      };
    } finally {
      res.release();
    }
  }

  async postJson(path: string, body: unknown, options: CallOptions = {}): Promise<JsonResult> {
    const res = await this.#send("POST", path, body, "inference", options, "application/json");
    try {
      return {
        data: await readJson(res.response, res.classify),
        requestId: res.requestId,
        status: res.response.status,
      };
    } finally {
      res.release();
    }
  }

  /**
   * POST and consume a Server-Sent Events response. The call budget
   * (timeoutMs) covers the wait for response headers; after that it becomes
   * an idle budget, reset on every chunk, so long generations that keep
   * streaming are never cut off while a stalled stream is.
   */
  async postStream(path: string, body: unknown, options: CallOptions = {}): Promise<StreamResult> {
    const idle = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
    const res = await this.#send(
      "POST",
      path,
      body,
      "inference",
      { ...options, signal },
      "text/event-stream",
    );
    // Headers are in: the call budget ends here and the idle budget takes over.
    res.release();
    const response = res.response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Some gateways answer a stream request with plain JSON (e.g. a cached
      // or error-shaped reply). Treat a JSON 200 as malformed for streaming.
      await response.body?.cancel().catch(() => undefined);
      throw new ModelGateMcpError("malformed_response", "ModelGate did not return an event stream.", {
        ...(res.requestId ? { requestId: res.requestId } : {}),
      });
    }
    if (!response.body) {
      throw new ModelGateMcpError("malformed_response", "ModelGate returned an empty stream.", {
        ...(res.requestId ? { requestId: res.requestId } : {}),
      });
    }
    const timeoutMs = this.#timeoutMs;
    const requestId = res.requestId;
    const callerSignal = options.signal;
    const body$ = response.body;

    async function* events(): AsyncGenerator<string> {
      let timer: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          idle.abort(
            new ModelGateMcpError("gateway_timeout", `ModelGate stream stalled for ${timeoutMs} ms.`),
          );
        }, timeoutMs);
      };
      arm();
      try {
        for await (const data of parseSse(body$)) {
          arm();
          yield data;
        }
      } catch (err) {
        throw classifyAbort(err, callerSignal, idle.signal, requestId) ?? streamError(err, requestId);
      } finally {
        clearTimeout(timer);
      }
    }

    return { requestId, events: events() };
  }

  async #send(
    method: "GET" | "POST",
    pathAndQuery: string,
    body: unknown,
    retryClass: RetryClass,
    options: CallOptions,
    accept: string,
  ): Promise<{
    response: Response;
    requestId: string | undefined;
    release: () => void;
    classify: (err: unknown) => ModelGateMcpError | undefined;
  }> {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const path = pathAndQuery.split("?")[0] ?? pathAndQuery;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...options.headers,
      authorization: `Bearer ${this.#apiKey}`,
      accept,
      "user-agent": userAgent(),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    };
    const deadline = Date.now() + this.#timeoutMs;

    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      // A clearable timer rather than AbortSignal.timeout(): the same signal
      // governs the response body, and a stream must outlive the call budget.
      const timeoutCtl = new AbortController();
      const timer = setTimeout(
        () => {
          timeoutCtl.abort(
            new ModelGateMcpError(
              "gateway_timeout",
              `ModelGate did not respond within ${this.#timeoutMs} ms (MODELGATE_TIMEOUT_MS).`,
              { retryable: true },
            ),
          );
        },
        Math.max(1, remaining),
      );
      const release = () => {
        clearTimeout(timer);
      };
      const timeout = timeoutCtl.signal;
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const started = Date.now();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          signal,
          // Never follow redirects: the Authorization header must only ever
          // reach the configured ModelGate origin.
          redirect: "error",
        });
      } catch (err) {
        release();
        const aborted = classifyAbort(err, options.signal, timeout, undefined);
        if (aborted) {
          if (
            aborted.code === "gateway_timeout" &&
            retryClass === "idempotent" &&
            this.#canRetry(attempt, deadline, 0)
          ) {
            continue;
          }
          throw aborted;
        }
        const netErr = networkError(err);
        this.#logger.debug("modelgate request failed", {
          method,
          path,
          attempt,
          code: networkErrorCode(err) ?? null,
        });
        if (shouldRetryNetworkError(retryClass, err) && this.#canRetry(attempt, deadline, 0)) {
          await this.#backoff(attempt, undefined, deadline, options.signal);
          continue;
        }
        throw netErr;
      }

      const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
      this.#logger.debug("modelgate response", {
        method,
        path,
        status: response.status,
        attempt,
        request_id: requestId ?? null,
        duration_ms: Date.now() - started,
      });
      if (response.ok) {
        const classify = (err: unknown) => classifyAbort(err, options.signal, timeout, requestId);
        return { response, requestId, release, classify };
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const errBody = await readErrorBody(response);
      release();
      const mapped = errorFromResponse({
        status: response.status,
        body: errBody,
        requestId,
        retryAfterSeconds: retryAfter,
        path,
      });
      if (shouldRetryStatus(retryClass, response.status) && this.#canRetry(attempt, deadline, retryAfter)) {
        await this.#backoff(attempt, retryAfter, deadline, options.signal);
        continue;
      }
      throw mapped;
    }
  }

  #canRetry(attempt: number, deadline: number, retryAfterSeconds: number | undefined): boolean {
    if (attempt >= this.#maxRetries) return false;
    const wait = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : 0;
    return Date.now() + wait + 250 < deadline;
  }

  async #backoff(
    attempt: number,
    retryAfter: number | undefined,
    deadline: number,
    signal: AbortSignal | undefined,
  ) {
    const delay = Math.min(backoffDelayMs(attempt, retryAfter), Math.max(0, deadline - Date.now() - 250));
    try {
      await sleep(delay, signal);
    } catch {
      throw new ModelGateMcpError("cancelled", "The request was cancelled.");
    }
  }
}

/** Map an abort (caller cancel vs. timeout) to a typed error, or undefined if not an abort. */
function classifyAbort(
  err: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  requestId: string | undefined,
): ModelGateMcpError | undefined {
  const opts = requestId ? { requestId } : {};
  if (callerSignal?.aborted) return new ModelGateMcpError("cancelled", "The request was cancelled.", opts);
  if (timeoutSignal.aborted) {
    const reason: unknown = timeoutSignal.reason;
    if (reason instanceof ModelGateMcpError) {
      return requestId && !reason.requestId
        ? new ModelGateMcpError(reason.code, reason.message, { retryable: reason.retryable, requestId })
        : reason;
    }
    return new ModelGateMcpError(
      "gateway_timeout",
      "ModelGate did not respond in time (MODELGATE_TIMEOUT_MS).",
      {
        ...opts,
        retryable: true,
      },
    );
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ModelGateMcpError("cancelled", "The request was cancelled.", opts);
  }
  return undefined;
}

function networkError(err: unknown): ModelGateMcpError {
  const code = networkErrorCode(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const redirect = err instanceof Error && /redirect/i.test(`${causeText} ${err.message}`);
  if (redirect) {
    return new ModelGateMcpError(
      "network_error",
      "ModelGate answered with a redirect, which this client refuses (credentials are never forwarded). Check MODELGATE_BASE_URL.",
    );
  }
  return new ModelGateMcpError(
    "network_error",
    `Could not reach ModelGate${code ? ` (${code})` : ""}. Check network access and MODELGATE_BASE_URL.`,
    { retryable: true, ...(code ? { details: { cause: code } } : {}) },
  );
}

function streamError(err: unknown, requestId: string | undefined): ModelGateMcpError {
  if (err instanceof ModelGateMcpError) return err;
  return new ModelGateMcpError("network_error", "The ModelGate stream was interrupted.", {
    retryable: false,
    ...(requestId ? { requestId } : {}),
  });
}

async function readBounded(response: Response, maxBytes: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(
  response: Response,
  classify: (err: unknown) => ModelGateMcpError | undefined,
): Promise<unknown> {
  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
  const opts = requestId ? { requestId } : {};
  const text = await readBounded(response, MAX_JSON_BYTES).catch((err: unknown) => {
    throw (
      classify(err) ?? new ModelGateMcpError("network_error", "The ModelGate response was interrupted.", opts)
    );
  });
  if (text === undefined)
    throw new ModelGateMcpError("malformed_response", "The ModelGate response is too large.", opts);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelGateMcpError(
      "malformed_response",
      "ModelGate returned a response that is not valid JSON.",
      opts,
    );
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await readBounded(response, MAX_ERROR_BYTES);
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}
