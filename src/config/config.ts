import { ConfigError } from "../errors/errors.js";
import { LOG_LEVELS, type LogLevel } from "../logging/logger.js";
import { registerSecret } from "../logging/redact.js";
import { DEFAULT_BASE_URL, isLoopbackHostname, validateBaseUrl } from "../security/baseUrl.js";
import { PROVIDERS, type Provider } from "../schemas/common.js";

export type TransportMode = "stdio" | "http";
export type RemoteAuthMode = "passthrough" | "token";

export interface HttpConfig {
  host: string;
  port: number;
  /**
   * passthrough: every MCP client sends its own ModelGate key as a bearer token
   *   and requests run with that key (tenant isolation enforced by ModelGate).
   * token: the server holds one MODELGATE_KEY and clients authenticate with a
   *   shared MCP auth token (single-tenant self-hosting).
   */
  authMode: RemoteAuthMode;
  authTokens: string[];
  allowedHosts: string[];
  allowedOrigins: string[];
  rateLimitPerMinute: number;
  maxBodyBytes: number;
}

export interface ModelGateMcpConfig {
  /** ModelGate key used for upstream calls (stdio, http token mode). Never logged. */
  apiKey: string | undefined;
  /** Gateway origin, e.g. https://gw.modelgatehq.com (no trailing slash, no /v1). */
  baseUrl: string;
  defaultModel: string | undefined;
  defaultProvider: Provider | undefined;
  /** Per-request budget for non-streaming calls; idle budget between stream chunks. */
  timeoutMs: number;
  /** Retries for safe-to-retry failures (see modelgate/retry.ts). */
  maxRetries: number;
  logLevel: LogLevel;
  /** Opt-in: allow debug logs to include prompt/response content. */
  logContent: boolean;
  /** Optional attribution tag sent as X-ModelGate-Environment. */
  environment: string | undefined;
  /** Upper bound on assistant text returned to the MCP client per call. */
  maxOutputChars: number;
  http: HttpConfig;
}

export type ConfigOverrides = Partial<Omit<ModelGateMcpConfig, "http">> & { http?: Partial<HttpConfig> };

export const ENV = {
  KEY: "MODELGATE_KEY",
  KEY_ALIAS: "MODELGATE_API_KEY",
  BASE_URL: "MODELGATE_BASE_URL",
  ALLOW_CUSTOM_BASE_URL: "MODELGATE_ALLOW_CUSTOM_BASE_URL",
  DEFAULT_MODEL: "MODELGATE_DEFAULT_MODEL",
  DEFAULT_PROVIDER: "MODELGATE_DEFAULT_PROVIDER",
  TIMEOUT_MS: "MODELGATE_TIMEOUT_MS",
  MAX_RETRIES: "MODELGATE_MAX_RETRIES",
  LOG_LEVEL: "MODELGATE_LOG_LEVEL",
  LOG_CONTENT: "MODELGATE_LOG_CONTENT",
  ENVIRONMENT: "MODELGATE_ENVIRONMENT",
  MAX_OUTPUT_CHARS: "MODELGATE_MAX_OUTPUT_CHARS",
  MCP_HOST: "MODELGATE_MCP_HOST",
  MCP_PORT: "MODELGATE_MCP_PORT",
  MCP_AUTH: "MODELGATE_MCP_AUTH",
  MCP_AUTH_TOKENS: "MODELGATE_MCP_AUTH_TOKENS",
  MCP_ALLOWED_HOSTS: "MODELGATE_MCP_ALLOWED_HOSTS",
  MCP_ALLOWED_ORIGINS: "MODELGATE_MCP_ALLOWED_ORIGINS",
  MCP_RATE_LIMIT: "MODELGATE_MCP_RATE_LIMIT",
  MCP_MAX_BODY_BYTES: "MODELGATE_MCP_MAX_BODY_BYTES",
} as const;

export const DEFAULTS = {
  timeoutMs: 120_000,
  maxRetries: 2,
  logLevel: "info" as LogLevel,
  maxOutputChars: 100_000,
  host: "127.0.0.1",
  port: 3333,
  rateLimitPerMinute: 120,
  maxBodyBytes: 1_048_576,
};

const MIN_AUTH_TOKEN_LEN = 32;

type Env = Record<string, string | undefined>;

/**
 * Load and validate configuration from environment variables plus optional
 * programmatic overrides (overrides win). Throws ConfigError listing every
 * problem; messages name the variable and never echo a secret value.
 */
export function loadConfig(options: {
  env?: Env;
  overrides?: ConfigOverrides;
  mode: TransportMode;
}): ModelGateMcpConfig {
  const env = options.env ?? process.env;
  const o = options.overrides ?? {};
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  // --- key -----------------------------------------------------------------
  const apiKey = o.apiKey ?? get(ENV.KEY) ?? get(ENV.KEY_ALIAS);
  if (apiKey !== undefined) {
    registerSecret(apiKey);
    if (!/^mg_[A-Za-z0-9_-]{8,}$/.test(apiKey)) {
      problems.push(`${ENV.KEY} does not look like a ModelGate API key (expected "mg_…")`);
    }
  }

  // --- base URL ------------------------------------------------------------
  let baseUrl = DEFAULT_BASE_URL;
  const rawBase = o.baseUrl ?? get(ENV.BASE_URL);
  if (rawBase !== undefined) {
    const r = validateBaseUrl(rawBase);
    if (r.ok) baseUrl = r.origin;
    else problems.push(r.problem);
  }

  // --- numbers / enums -----------------------------------------------------
  const timeoutMs =
    o.timeoutMs ?? int(get(ENV.TIMEOUT_MS), ENV.TIMEOUT_MS, DEFAULTS.timeoutMs, 1_000, 600_000, problems);
  const maxRetries =
    o.maxRetries ?? int(get(ENV.MAX_RETRIES), ENV.MAX_RETRIES, DEFAULTS.maxRetries, 0, 5, problems);
  const maxOutputChars =
    o.maxOutputChars ??
    int(get(ENV.MAX_OUTPUT_CHARS), ENV.MAX_OUTPUT_CHARS, DEFAULTS.maxOutputChars, 1_000, 2_000_000, problems);

  const rawLevel = (o.logLevel ?? get(ENV.LOG_LEVEL) ?? DEFAULTS.logLevel).toLowerCase();
  let logLevel: LogLevel = DEFAULTS.logLevel;
  if ((LOG_LEVELS as readonly string[]).includes(rawLevel)) logLevel = rawLevel as LogLevel;
  else problems.push(`${ENV.LOG_LEVEL} must be one of ${LOG_LEVELS.join(", ")}`);

  const logContent = o.logContent ?? bool(get(ENV.LOG_CONTENT), ENV.LOG_CONTENT, false, problems);

  const defaultModel = o.defaultModel ?? get(ENV.DEFAULT_MODEL);
  if (defaultModel !== undefined && !/^[\w.:/@-]{1,128}$/.test(defaultModel)) {
    problems.push(`${ENV.DEFAULT_MODEL} is not a valid model id`);
  }
  const rawProvider = o.defaultProvider ?? get(ENV.DEFAULT_PROVIDER)?.toUpperCase();
  let defaultProvider: Provider | undefined;
  if (rawProvider !== undefined) {
    if ((PROVIDERS as readonly string[]).includes(rawProvider)) defaultProvider = rawProvider as Provider;
    else problems.push(`${ENV.DEFAULT_PROVIDER} must be one of ${PROVIDERS.join(", ")}`);
  }

  const environment = o.environment ?? get(ENV.ENVIRONMENT);
  if (environment !== undefined && !/^[\w.-]{1,64}$/.test(environment)) {
    problems.push(`${ENV.ENVIRONMENT} may only contain letters, digits, ".", "_" or "-" (max 64)`);
  }

  // --- remote (HTTP) --------------------------------------------------------
  const oh = o.http ?? {};
  const host = oh.host ?? get(ENV.MCP_HOST) ?? DEFAULTS.host;
  const port = oh.port ?? int(get(ENV.MCP_PORT), ENV.MCP_PORT, DEFAULTS.port, 0, 65_535, problems);
  const rawAuth = (oh.authMode ?? get(ENV.MCP_AUTH) ?? "passthrough").toLowerCase();
  let authMode: RemoteAuthMode = "passthrough";
  if (rawAuth === "passthrough" || rawAuth === "token") authMode = rawAuth;
  else problems.push(`${ENV.MCP_AUTH} must be "passthrough" or "token"`);
  const authTokens = oh.authTokens ?? list(get(ENV.MCP_AUTH_TOKENS));
  authTokens.forEach((t) => {
    registerSecret(t);
  });
  const loopbackBind = isLoopbackHostname(host);
  const allowedHosts =
    oh.allowedHosts ??
    (list(get(ENV.MCP_ALLOWED_HOSTS)).length
      ? list(get(ENV.MCP_ALLOWED_HOSTS))
      : loopbackBind
        ? ["localhost", "127.0.0.1", "[::1]"]
        : []);
  const allowedOrigins =
    oh.allowedOrigins ??
    (list(get(ENV.MCP_ALLOWED_ORIGINS)).length
      ? list(get(ENV.MCP_ALLOWED_ORIGINS))
      : ["localhost", "127.0.0.1", "[::1]"]);
  const rateLimitPerMinute =
    oh.rateLimitPerMinute ??
    int(get(ENV.MCP_RATE_LIMIT), ENV.MCP_RATE_LIMIT, DEFAULTS.rateLimitPerMinute, 1, 100_000, problems);
  const maxBodyBytes =
    oh.maxBodyBytes ??
    int(
      get(ENV.MCP_MAX_BODY_BYTES),
      ENV.MCP_MAX_BODY_BYTES,
      DEFAULTS.maxBodyBytes,
      1_024,
      16_777_216,
      problems,
    );

  // --- mode-specific requirements --------------------------------------------
  if (options.mode === "stdio" && apiKey === undefined) {
    problems.push(
      `${ENV.KEY} is not set. Create an integration key in the ModelGate dashboard (API keys → "Integration (MCP / agents)") and set ${ENV.KEY}=mg_…`,
    );
  }
  if (options.mode === "http") {
    if (authMode === "token") {
      if (apiKey === undefined)
        problems.push(`${ENV.MCP_AUTH}=token requires ${ENV.KEY} (the key the server uses upstream)`);
      if (authTokens.length === 0) {
        problems.push(
          `${ENV.MCP_AUTH}=token requires ${ENV.MCP_AUTH_TOKENS} (comma-separated, each ≥ ${MIN_AUTH_TOKEN_LEN} chars)`,
        );
      }
      if (authTokens.some((t) => t.length < MIN_AUTH_TOKEN_LEN)) {
        problems.push(`every ${ENV.MCP_AUTH_TOKENS} entry must be at least ${MIN_AUTH_TOKEN_LEN} characters`);
      }
    }
    if (!loopbackBind && allowedHosts.length === 0) {
      problems.push(
        `binding ${ENV.MCP_HOST}=${host} (non-loopback) requires ${ENV.MCP_ALLOWED_HOSTS} (the public hostname(s) clients use), for DNS-rebinding protection`,
      );
    }
    if (
      baseUrl !== DEFAULT_BASE_URL &&
      !bool(get(ENV.ALLOW_CUSTOM_BASE_URL), ENV.ALLOW_CUSTOM_BASE_URL, false, problems)
    ) {
      problems.push(
        `remote mode with a non-default ${ENV.BASE_URL} requires ${ENV.ALLOW_CUSTOM_BASE_URL}=true (prevents the server from being pointed at an arbitrary host)`,
      );
    }
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    apiKey,
    baseUrl,
    defaultModel,
    defaultProvider,
    timeoutMs,
    maxRetries,
    logLevel,
    logContent,
    environment,
    maxOutputChars,
    http: {
      host,
      port,
      authMode,
      authTokens,
      allowedHosts,
      allowedOrigins,
      rateLimitPerMinute,
      maxBodyBytes,
    },
  };
}

/** A config summary that is safe to print or expose (no secrets). */
export function describeConfig(cfg: ModelGateMcpConfig, mode: TransportMode): Record<string, unknown> {
  return {
    mode,
    base_url: cfg.baseUrl,
    api_key_configured: cfg.apiKey !== undefined,
    default_model: cfg.defaultModel ?? null,
    default_provider: cfg.defaultProvider ?? null,
    timeout_ms: cfg.timeoutMs,
    max_retries: cfg.maxRetries,
    log_level: cfg.logLevel,
    log_content: cfg.logContent,
    environment: cfg.environment ?? null,
    max_output_chars: cfg.maxOutputChars,
    ...(mode === "http"
      ? {
          http: {
            host: cfg.http.host,
            port: cfg.http.port,
            auth_mode: cfg.http.authMode,
            auth_tokens_configured: cfg.http.authTokens.length,
            allowed_hosts: cfg.http.allowedHosts,
            allowed_origins: cfg.http.allowedOrigins,
            rate_limit_per_minute: cfg.http.rateLimitPerMinute,
            max_body_bytes: cfg.http.maxBodyBytes,
          },
        }
      : {}),
  };
}

function int(
  raw: string | undefined,
  name: string,
  def: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be an integer`);
    return def;
  }
  const n = Number(raw);
  if (n < min || n > max) {
    problems.push(`${name} must be between ${min} and ${max}`);
    return def;
  }
  return n;
}

function bool(raw: string | undefined, name: string, def: boolean, problems: string[]): boolean {
  if (raw === undefined) return def;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  problems.push(`${name} must be true or false`);
  return def;
}

function list(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
