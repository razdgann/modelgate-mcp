import { randomUUID } from "node:crypto";
import { CLIENT_INFO_META_KEY, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { ModelGateMcpConfig, TransportMode } from "../config/config.js";
import { normalizeError, toolErrorResult } from "../errors/toolResult.js";
import type { Logger } from "../logging/logger.js";
import type { ClientIdentity } from "../modelgate/attribution.js";
import type { ModelGateClient } from "../modelgate/client.js";

/** Everything a tool/resource/prompt handler needs; one per MCP server instance. */
export interface ToolEnv {
  client: ModelGateClient;
  config: ModelGateMcpConfig;
  logger: Logger;
  transport: TransportMode;
  /** Legacy-era fallback for client identity (initialize handshake). */
  handshakeClient: () => ClientIdentity | undefined;
}

/** Client identity: the 2026-07-28 per-request envelope, else the initialize handshake. */
export function clientIdentity(env: ToolEnv, ctx: ServerContext): ClientIdentity | undefined {
  const fromEnvelope = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_INFO_META_KEY];
  if (fromEnvelope && typeof fromEnvelope === "object") {
    const info = fromEnvelope as { name?: unknown; version?: unknown };
    return {
      name: typeof info.name === "string" ? info.name : undefined,
      version: typeof info.version === "string" ? info.version : undefined,
    };
  }
  return env.handshakeClient();
}

export function newCorrelationId(): string {
  return `mcp_${randomUUID()}`;
}

/**
 * Run a tool body with consistent logging and error handling: every failure
 * becomes a sanitized isError result carrying a stable code, retryability and
 * the ModelGate request id; nothing internal (stacks, causes, keys) escapes.
 * Logs carry tool name, outcome, duration and request id — never content.
 */
export async function runTool(
  env: ToolEnv,
  tool: string,
  fn: (log: Logger) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const log = env.logger.child({ tool });
  const started = Date.now();
  try {
    const result = await fn(log);
    const requestId = (result.structuredContent as { request_id?: unknown } | undefined)?.request_id;
    log.info("tool call ok", {
      duration_ms: Date.now() - started,
      request_id: typeof requestId === "string" ? requestId : null,
    });
    return result;
  } catch (err) {
    const e = normalizeError(err, log);
    log.warn("tool call failed", {
      duration_ms: Date.now() - started,
      code: e.code,
      retryable: e.retryable,
      http_status: e.status ?? null,
      request_id: e.requestId ?? null,
    });
    return toolErrorResult(e);
  }
}

/** Truncate text to a character budget, reporting whether it was cut. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
