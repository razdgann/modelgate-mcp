import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Logger } from "../logging/logger.js";
import { ModelGateMcpError } from "./errors.js";

/**
 * Normalize anything thrown inside a handler into a ModelGateMcpError. Known
 * errors pass through; everything else becomes an opaque internal_error (the
 * original is logged, redacted, at error level — never returned to clients).
 */
export function normalizeError(err: unknown, logger: Logger): ModelGateMcpError {
  if (err instanceof ModelGateMcpError) return err;
  logger.error("unexpected internal error", { error: err });
  return new ModelGateMcpError("internal_error", "Internal error in the ModelGate MCP server.");
}

/**
 * MCP tool-level error result (isError: true). Tool errors are returned as
 * results rather than protocol errors so the calling model can read them and
 * self-correct, per the MCP tools specification.
 */
export function toolErrorResult(error: ModelGateMcpError): CallToolResult {
  const lines = [`ModelGate error [${error.code}]: ${error.message}`];
  if (error.requestId) lines.push(`ModelGate request id: ${error.requestId}`);
  lines.push(error.retryable ? "Retryable: yes" : "Retryable: no");
  return {
    isError: true,
    content: [
      { type: "text", text: lines.join("\n") },
      { type: "text", text: JSON.stringify({ error: error.toJSON() }) },
    ],
  };
}
