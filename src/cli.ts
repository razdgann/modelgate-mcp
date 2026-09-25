#!/usr/bin/env node
import { parseArgs } from "node:util";
import { describeConfig, loadConfig, type ConfigOverrides, type TransportMode } from "./config/config.js";
import { ConfigError, ModelGateMcpError } from "./errors/errors.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { redactString } from "./logging/redact.js";
import { getMe } from "./modelgate/api.js";
import { ModelGateClient } from "./modelgate/client.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

const HELP = `${PACKAGE_NAME} ${VERSION} — Model Context Protocol server for ModelGate

Usage:
  ${PACKAGE_NAME} [stdio]            Serve MCP over stdio (default; for Claude Desktop, Claude Code, Cursor, VS Code)
  ${PACKAGE_NAME} http [options]     Serve MCP over Streamable HTTP (remote)
  ${PACKAGE_NAME} check [--http]     Validate configuration and test the ModelGate connection
  ${PACKAGE_NAME} --version | --help

HTTP options (override the matching environment variables):
  --host <host>     Bind address        (MODELGATE_MCP_HOST, default 127.0.0.1)
  --port <port>     Port                (MODELGATE_MCP_PORT, default 3333)

Environment:
  MODELGATE_KEY           ModelGate API key (mg_…). Required for stdio. Use an integration-scoped key.
  MODELGATE_BASE_URL      Gateway origin (default https://gw.modelgatehq.com)
  MODELGATE_DEFAULT_MODEL Model used when a tool call omits "model"
  MODELGATE_TIMEOUT_MS    Request timeout / stream idle timeout (default 120000)
  MODELGATE_LOG_LEVEL     error | warn | info | debug (default info; logs go to stderr)
  See https://github.com/razdgann/modelgate-mcp#configuration for the full reference.
`;

function write(stream: NodeJS.WriteStream, text: string) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        http: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
      },
    });
  } catch (err) {
    write(process.stderr, `${redactString(err instanceof Error ? err.message : String(err))}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    write(process.stdout, HELP);
    return 0;
  }
  if (values.version) {
    write(process.stdout, VERSION);
    return 0;
  }
  const command = positionals[0] ?? "stdio";
  if (!["stdio", "http", "check"].includes(command) || positionals.length > 1) {
    write(process.stderr, `Unknown command: ${positionals.join(" ")}\n\n${HELP}`);
    return 2;
  }

  const mode: TransportMode =
    command === "http" || (command === "check" && values.http === true) ? "http" : "stdio";
  const overrides: ConfigOverrides = {};
  if (values.host !== undefined || values.port !== undefined) {
    overrides.http = {};
    if (values.host !== undefined) overrides.http.host = values.host;
    if (values.port !== undefined) {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        write(process.stderr, "--port must be an integer between 0 and 65535");
        return 2;
      }
      overrides.http.port = port;
    }
  }

  let config;
  try {
    config = loadConfig({ mode, overrides });
  } catch (err) {
    if (err instanceof ConfigError) {
      write(process.stderr, err.message);
      return 2;
    }
    throw err;
  }
  const logger = createLogger({ level: config.logLevel });

  if (command === "check") return runCheck(config, mode, logger);

  const running = mode === "http" ? await startHttp(config, logger) : startStdio(config, logger);
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { reason });
    const hard = setTimeout(() => process.exit(0), 15_000);
    hard.unref();
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => {
    stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    stop("SIGTERM");
  });
  if (mode === "stdio")
    process.stdin.once("end", () => {
      stop("stdin closed");
    });
  return -1; // keep running
}

async function runCheck(
  config: ReturnType<typeof loadConfig>,
  mode: TransportMode,
  logger: Logger,
): Promise<number> {
  write(process.stdout, `${PACKAGE_NAME} ${VERSION} configuration: OK`);
  write(process.stdout, JSON.stringify(describeConfig(config, mode), null, 2));
  let ok = true;
  try {
    const res = await fetch(`${config.baseUrl}/health`, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    write(
      process.stdout,
      `gateway ${config.baseUrl}/health: ${res.status === 200 ? "reachable" : `HTTP ${res.status}`}`,
    );
    ok &&= res.ok;
  } catch (err) {
    write(
      process.stdout,
      `gateway ${config.baseUrl}/health: unreachable (${redactString(err instanceof Error ? err.message : String(err))})`,
    );
    ok = false;
  }
  if (!config.apiKey) {
    write(process.stdout, "API key: not configured (http passthrough mode: clients send their own keys)");
    return ok ? 0 : 1;
  }
  try {
    const client = new ModelGateClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs: 15_000,
      maxRetries: 1,
      logger,
    });
    const { me } = await getMe(client, {});
    write(
      process.stdout,
      `API key: valid — project "${me.project.name ?? me.project.id}", scopes: ${me.scopes.join(", ")}${me.legacy_full_access ? " (legacy full-access key: consider an integration-scoped key)" : ""}`,
    );
  } catch (err) {
    if (err instanceof ModelGateMcpError && err.code === "endpoint_unavailable") {
      write(
        process.stdout,
        "API key: cannot verify (this gateway has no /v1/me yet); inference will still work",
      );
    } else {
      const e =
        err instanceof ModelGateMcpError ? err : new ModelGateMcpError("internal_error", "unexpected error");
      write(process.stdout, `API key: FAILED [${e.code}] ${e.message}`);
      ok = false;
    }
  }
  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    write(process.stderr, `fatal: ${redactString(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  },
);
