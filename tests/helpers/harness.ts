import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { loadConfig, type ConfigOverrides } from "../../src/config/config.js";
import { createLogger, type Logger } from "../../src/logging/logger.js";
import { createServerFactory } from "../../src/server.js";
import { KEY_A } from "./mockGateway.js";

export interface LogCapture {
  lines: string[];
  logger: Logger;
  text(): string;
}

export function captureLogs(level: "error" | "warn" | "info" | "debug" = "debug"): LogCapture {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: { write: (l: string) => lines.push(l) } });
  return { lines, logger, text: () => lines.join("") };
}

/** Connect an MCP client to a fresh server instance over an in-memory transport. */
export async function connect(baseUrl: string, overrides: ConfigOverrides = {}, logs = captureLogs()) {
  const config = loadConfig({
    mode: "stdio",
    env: {},
    overrides: { apiKey: KEY_A, baseUrl, maxRetries: 2, timeoutMs: 5_000, ...overrides },
  });
  const server = createServerFactory({ config, logger: logs.logger, transport: "stdio" })();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "1.2.3" });
  await client.connect(clientT);
  return {
    client,
    logs,
    config,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function text(r: CallToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

export function errorOf(r: CallToolResult): {
  code: string;
  retryable: boolean;
  request_id?: string;
  details?: Record<string, unknown>;
} {
  if (!r.isError) throw new Error(`expected an error result, got: ${text(r).slice(0, 200)}`);
  const last = r.content[r.content.length - 1];
  if (last?.type !== "text") throw new Error("no error json");
  return (JSON.parse(last.text) as { error: ReturnType<typeof errorOf> }).error;
}
