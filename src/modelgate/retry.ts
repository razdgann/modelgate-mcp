// Retry policy.
//
// Reads (GET /v1/models, /v1/usage, /v1/requests/:id, /v1/me) are idempotent:
// they retry network failures, 429, 500, 502, 503 and 504.
//
// Inference (POST /v1/chat/completions) is billable and NOT idempotent. A
// retry after the gateway may already have called the provider could run —
// and bill — the same generation twice. ModelGate itself already retries the
// provider once and fails over to a secondary provider, so this client only
// retries inference when the failure proves nothing reached a provider:
//   - 429 rate_limited (ModelGate rejects before calling any provider);
//   - connection-establishment errors (DNS failure, connection refused),
//     where the request never left this machine.
// 5xx, timeouts, and resets mid-request are surfaced to the caller instead.
//
// Backoff: exponential with full jitter (base 500 ms, cap 8 s), honouring
// Retry-After (capped at 30 s), and never sleeping past the caller's deadline.

export type RetryClass = "idempotent" | "inference";

const RETRYABLE_READ_STATUS = new Set([429, 500, 502, 503, 504]);

/** Error codes (undici/Node) that mean the TCP connection never opened. */
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function shouldRetryStatus(cls: RetryClass, status: number): boolean {
  return cls === "idempotent" ? RETRYABLE_READ_STATUS.has(status) : status === 429;
}

export function shouldRetryNetworkError(cls: RetryClass, err: unknown): boolean {
  if (cls === "idempotent") return true;
  return PRE_CONNECT_CODES.has(networkErrorCode(err) ?? "");
}

export function networkErrorCode(err: unknown): string | undefined {
  // fetch() wraps the socket error: TypeError("fetch failed", { cause: { code } }).
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function backoffDelayMs(
  attempt: number,
  retryAfterSeconds: number | undefined,
  random = Math.random,
): number {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  const ceiling = Math.min(500 * 2 ** attempt, 8_000);
  return Math.floor(random() * ceiling);
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Sleep that resolves early (rejecting) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
