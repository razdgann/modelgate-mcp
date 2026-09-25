import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import type { ModelGateMcpConfig, TransportMode } from "./config/config.js";
import { ModelGateMcpError } from "./errors/errors.js";
import type { Logger } from "./logging/logger.js";
import { ModelGateClient, type FetchFn } from "./modelgate/client.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerChatTools } from "./tools/chat.js";
import type { ToolEnv } from "./tools/context.js";
import { registerReadTools } from "./tools/read.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "modelgate";

export const SERVER_INSTRUCTIONS = [
  "ModelGate is an OpenAI-compatible LLM gateway that tracks tokens, cost, latency and guardrail findings for every request.",
  "Use modelgate_models to discover models, modelgate_chat (or modelgate_chat_stream) to run inference through ModelGate,",
  "modelgate_usage for aggregate spend, and modelgate_request with a request_id to inspect one request.",
  "Every inference result includes request_id, the canonical ModelGate id for that call.",
].join(" ");

export interface ServerFactoryOptions {
  config: ModelGateMcpConfig;
  logger: Logger;
  transport: TransportMode;
  /** Override fetch (tests). */
  fetch?: FetchFn;
}

/**
 * Build the MCP server factory used by both transports. The factory runs once
 * per stdio connection and once per HTTP request (the SDK's stateless model),
 * so each instance is bound to exactly one ModelGate credential:
 *   - stdio / http token mode: the configured MODELGATE_KEY;
 *   - http passthrough mode: the caller's own key from the validated bearer
 *     token (ctx.authInfo) — so a caller can only ever act as its own
 *     ModelGate project, and ModelGate enforces scopes and tenant isolation.
 */
export function createServerFactory(options: ServerFactoryOptions) {
  const { config, logger, transport } = options;

  return (ctx?: McpRequestContext): McpServer => {
    const apiKey = resolveKey(options, ctx);
    const client = new ModelGateClient({
      baseUrl: config.baseUrl,
      apiKey,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      logger: logger.child({ component: "modelgate-client" }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    const server = new McpServer(
      { name: SERVER_NAME, title: "ModelGate", version: VERSION, websiteUrl: "https://modelgatehq.com" },
      { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    const env: ToolEnv = {
      client,
      config,
      logger: logger.child({ transport, era: ctx?.era ?? "unknown" }),
      transport,
      // 2025-era connections carry client identity only in the initialize
      // handshake; this accessor is the SDK's documented source for that era
      // (2026-07-28 requests are read from ctx.mcpReq.envelope first).
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      handshakeClient: () => server.server.getClientVersion(),
    };

    registerChatTools(server, env);
    registerReadTools(server, env);
    registerResources(server, env);
    registerPrompts(server);
    return server;
  };
}

function resolveKey(options: ServerFactoryOptions, ctx: McpRequestContext | undefined): string {
  if (options.transport === "http" && options.config.http.authMode === "passthrough") {
    const token = ctx?.authInfo?.token;
    // The HTTP transport authenticates before any instance is built; this is
    // a defence-in-depth check, never a fallback to a server-held key.
    if (!token) throw new ModelGateMcpError("auth_missing", "No ModelGate key on this request.");
    return token;
  }
  if (!options.config.apiKey) throw new ModelGateMcpError("auth_missing", "MODELGATE_KEY is not configured.");
  return options.config.apiKey;
}
