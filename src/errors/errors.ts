import { redactString } from "../logging/redact.js";

/**
 * Stable, programmatic error codes surfaced to MCP clients. Agents can branch
 * on `code` and `retryable`; humans get `message` (always actionable, always
 * sanitized).
 */
export const ERROR_CODES = [
  "config_invalid",
  "auth_missing",
  "auth_invalid",
  "insufficient_scope",
  "invalid_request",
  "invalid_model",
  "provider_required",
  "provider_not_configured",
  "rate_limited",
  "quota_exceeded",
  "payload_too_large",
  "guardrail_blocked",
  "stream_unavailable",
  "provider_error",
  "provider_timeout",
  "gateway_error",
  "gateway_timeout",
  "network_error",
  "cancelled",
  "malformed_response",
  "not_found",
  "endpoint_unavailable",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Small, JSON-safe, secret-free context attached to an error. */
export type ErrorDetails = Record<string, string | number | boolean | null | string[]>;

export interface ModelGateMcpErrorOptions {
  retryable?: boolean;
  status?: number;
  requestId?: string;
  retryAfterSeconds?: number;
  details?: ErrorDetails;
  cause?: unknown;
}

export class ModelGateMcpError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, options: ModelGateMcpErrorOptions = {}) {
    super(redactString(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelGateMcpError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }

  /** The client-facing shape. Contains no stack, cause, or credential. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status !== undefined ? { http_status: this.status } : {}),
      ...(this.requestId !== undefined ? { request_id: this.requestId } : {}),
      ...(this.retryAfterSeconds !== undefined ? { retry_after_seconds: this.retryAfterSeconds } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Thrown by configuration loading; lists every problem at once. */
export class ConfigError extends ModelGateMcpError {
  readonly problems: string[];
  constructor(problems: string[]) {
    super("config_invalid", `Invalid ModelGate MCP configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems.map(redactString);
  }
}

export function isModelGateMcpError(e: unknown): e is ModelGateMcpError {
  return e instanceof ModelGateMcpError;
}
