import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ModelGateMcpConfig } from "../config/config.js";
import type { Logger } from "../logging/logger.js";
import { createServerFactory } from "../server.js";

export interface RunningServer {
  close(): Promise<void>;
}

/**
 * Serve MCP over stdio (Claude Desktop, Claude Code, Cursor, VS Code, ...).
 * stdout carries only protocol frames; all logging goes to stderr.
 * Serves both the 2026-07-28 protocol and 2025-era clients (SDK negotiation).
 */
export function startStdio(config: ModelGateMcpConfig, logger: Logger): RunningServer {
  const factory = createServerFactory({ config, logger, transport: "stdio" });
  const handle = serveStdio(factory, {
    onerror: (error) => {
      logger.warn("stdio transport error", { error });
    },
  });
  logger.info("modelgate-mcp listening on stdio", { base_url: config.baseUrl });
  return { close: () => handle.close() };
}
