import { ModelGateMcpError, type ErrorDetails } from "./errors.js";

/**
 * Translate a non-2xx ModelGate response into a ModelGateMcpError.
 *
 * Only fields ModelGate documents (docs/GATEWAY.md "Errors") are read from the
 * body, and only as bounded primitives — never the raw body — so an upstream
 * that echoes request content or internals cannot leak it through an error.
 */
export function errorFromResponse(params: {
  status: number;
  body: unknown;
  requestId?: string | undefined;
  retryAfterSeconds?: number | undefined;
  path: string;
}): ModelGateMcpError {
  const { status, path } = params;
  const body = isRecord(params.body) ? params.body : {};
  const code = typeof body.error === "string" ? body.error.slice(0, 64) : undefined;
  const base = {
    status,
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    ...(params.retryAfterSeconds !== undefined ? { retryAfterSeconds: params.retryAfterSeconds } : {}),
  };
  const withDetails = (details: ErrorDetails) => ({ ...base, details });

  switch (status) {
    case 400: {
      if (code === "provider_required") {
        return new ModelGateMcpError(
          "provider_required",
          "No provider was specified and the ModelGate project has no primary provider. Pass `provider` (e.g. OPENAI) or set a primary provider in the ModelGate dashboard (Settings).",
          base,
        );
      }
      if (code === "provider_not_configured") {
        const provider = str(body.provider, 32);
        return new ModelGateMcpError(
          "provider_not_configured",
          `The ModelGate project has no ${provider ?? "provider"} credential. Add one in the ModelGate dashboard (Provider credentials), or choose a model from a configured provider (see modelgate_models).`,
          withDetails({ provider: provider ?? null }),
        );
      }
      return new ModelGateMcpError(
        "invalid_request",
        `ModelGate rejected the request as malformed${fieldList(body)}.`,
        withDetails({ gateway_error: code ?? null, fields: fieldNames(body) }),
      );
    }
    case 401:
      return new ModelGateMcpError(
        "auth_invalid",
        "ModelGate rejected the API key (missing, invalid, or revoked). Check MODELGATE_KEY, or create a new key in the ModelGate dashboard (API keys).",
        base,
      );
    case 402:
      return new ModelGateMcpError(
        "quota_exceeded",
        "The ModelGate project's monthly spend cap has been reached. Raise the cap in the ModelGate dashboard (Settings) or wait for the next billing month.",
        base,
      );
    case 403: {
      if (code === "insufficient_scope") {
        const scope = str(body.required_scope, 64);
        return new ModelGateMcpError(
          "insufficient_scope",
          `This ModelGate API key lacks the "${scope ?? "required"}" scope. Create an integration key with that scope in the ModelGate dashboard (API keys → Integration (MCP / agents)).`,
          withDetails({ required_scope: scope ?? null }),
        );
      }
      const category = str(body.category, 64) ?? "guardrail";
      const score = typeof body.score === "number" && Number.isFinite(body.score) ? body.score : null;
      return new ModelGateMcpError(
        "guardrail_blocked",
        `ModelGate guardrails blocked this request (${category}${score !== null ? `, risk score ${score}` : ""}). Remove the flagged content or review the project's guardrail settings.`,
        withDetails({ category, score }),
      );
    }
    case 404: {
      if (code === "request_not_found") {
        return new ModelGateMcpError(
          "not_found",
          "No request with that id exists in this ModelGate project.",
          base,
        );
      }
      return new ModelGateMcpError(
        "endpoint_unavailable",
        `This ModelGate deployment does not provide ${path}. It needs a ModelGate version with the integration API (GET /v1/models, /v1/usage, /v1/requests/:id, /v1/me).`,
        withDetails({ path }),
      );
    }
    case 409:
      return new ModelGateMcpError(
        "stream_unavailable",
        "Streaming is disabled for this project because outbound secret/PII redaction is in ENFORCE mode. Use modelgate_chat (non-streaming) instead.",
        base,
      );
    case 413:
      return new ModelGateMcpError(
        "payload_too_large",
        code === "max_output_too_large"
          ? "max_tokens exceeds the project's configured output-token limit. Lower max_tokens or raise the limit in ModelGate settings."
          : "The prompt exceeds the project's configured prompt-token limit. Shorten the messages or raise the limit in ModelGate settings.",
        withDetails({ gateway_error: code ?? null }),
      );
    case 429:
      return new ModelGateMcpError(
        "rate_limited",
        `ModelGate rate limit reached${params.retryAfterSeconds !== undefined ? `; retry after ${params.retryAfterSeconds}s` : ""}.`,
        { ...base, retryable: true },
      );
    case 499:
      return new ModelGateMcpError("cancelled", "The request was cancelled.", base);
    case 502:
      if (code === "provider_error") return providerError(body, base);
      return new ModelGateMcpError("gateway_error", "ModelGate is temporarily unreachable (502).", {
        ...base,
        retryable: true,
      });
    case 504:
      return new ModelGateMcpError("gateway_timeout", "ModelGate timed out upstream (504).", {
        ...base,
        retryable: true,
      });
    default:
      if (status >= 500) {
        return new ModelGateMcpError(
          "gateway_error",
          `ModelGate returned an internal error (${status}). If it persists, look up the request id in the ModelGate dashboard.`,
          { ...base, retryable: true },
        );
      }
      return new ModelGateMcpError(
        "gateway_error",
        `ModelGate returned an unexpected status ${status}.`,
        base,
      );
  }
}

function providerError(
  body: Record<string, unknown>,
  base: { status: number; requestId?: string; retryAfterSeconds?: number },
): ModelGateMcpError {
  const ps = typeof body.provider_status === "number" ? body.provider_status : null;
  const retryable = body.retryable === true;
  const details = { provider_status: ps };
  if (ps === 404) {
    return new ModelGateMcpError(
      "invalid_model",
      "The provider does not recognize this model (404). Use modelgate_models to list the models available to this project.",
      { ...base, details },
    );
  }
  if (ps === 408 || ps === 504) {
    return new ModelGateMcpError("provider_timeout", "The upstream provider timed out.", {
      ...base,
      retryable: true,
      details,
    });
  }
  if (ps === 401 || ps === 403) {
    return new ModelGateMcpError(
      "provider_error",
      "The upstream provider rejected the project's stored credential. Update it in the ModelGate dashboard (Provider credentials).",
      { ...base, details },
    );
  }
  if (ps === 400 || ps === 422) {
    return new ModelGateMcpError(
      "provider_error",
      "The upstream provider rejected the request parameters (400). Check the model name, message format, and tool/response_format definitions.",
      { ...base, details },
    );
  }
  return new ModelGateMcpError(
    "provider_error",
    `The upstream provider failed${ps !== null ? ` (${ps})` : ""}.`,
    { ...base, retryable, details },
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  return v.replace(/[^\w.:/-]/g, "").slice(0, max) || undefined;
}

// Zod-flattened validation details from ModelGate: {details:{fieldErrors:{model:["Required"]}}}.
function fieldNames(body: Record<string, unknown>): string[] {
  const details = isRecord(body.details) ? body.details : undefined;
  const fe = details && isRecord(details.fieldErrors) ? details.fieldErrors : undefined;
  if (!fe) return [];
  return Object.keys(fe)
    .slice(0, 10)
    .map((k) => k.replace(/[^\w.-]/g, "").slice(0, 40));
}

function fieldList(body: Record<string, unknown>): string {
  const f = fieldNames(body);
  return f.length ? ` (invalid fields: ${f.join(", ")})` : "";
}
