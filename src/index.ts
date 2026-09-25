// Programmatic API. Most users run the CLI (`npx modelgate-mcp`); embedders can
// build the same server and mount it on their own transport.
export {
  createServerFactory,
  SERVER_NAME,
  SERVER_INSTRUCTIONS,
  type ServerFactoryOptions,
} from "./server.js";
export {
  loadConfig,
  describeConfig,
  ENV,
  DEFAULTS,
  type ModelGateMcpConfig,
  type ConfigOverrides,
  type HttpConfig,
  type TransportMode,
  type RemoteAuthMode,
} from "./config/config.js";
export { startStdio, type RunningServer } from "./transports/stdio.js";
export { startHttp, MCP_PATH, HEALTH_PATH, type RunningHttpServer } from "./transports/http.js";
export { ModelGateMcpError, ConfigError, ERROR_CODES, type ErrorCode } from "./errors/errors.js";
export { createLogger, silentLogger, type Logger, type LogLevel } from "./logging/logger.js";
export { ModelGateClient, REQUEST_ID_HEADER, type FetchFn } from "./modelgate/client.js";
export { DEFAULT_BASE_URL } from "./security/baseUrl.js";
export { PACKAGE_NAME, VERSION } from "./version.js";
