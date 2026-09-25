import { redactString, redactValue } from "./redact.js";

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogSink {
  write(line: string): unknown;
}

export interface Logger {
  readonly level: LogLevel;
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  isEnabled(level: LogLevel): boolean;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Structured JSON-lines logger. Writes to stderr by default — in stdio mode
 * stdout carries the MCP protocol and must never receive log output. Every
 * record is redacted (keys, bearer tokens, registered secrets) and serialized
 * with JSON.stringify, so caller-controlled text cannot inject fake log lines.
 */
export function createLogger(
  options: {
    level?: LogLevel;
    sink?: LogSink;
    bindings?: Record<string, unknown>;
  } = {},
): Logger {
  const level = options.level ?? "info";
  const sink: LogSink = options.sink ?? process.stderr;
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[lvl] > RANK[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactString(msg),
      ...(redactValue({ ...bindings, ...fields }) as Record<string, unknown>),
    };
    try {
      sink.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging must never take the server down.
    }
  };

  return {
    level,
    error: (m, f) => {
      emit("error", m, f);
    },
    warn: (m, f) => {
      emit("warn", m, f);
    },
    info: (m, f) => {
      emit("info", m, f);
    },
    debug: (m, f) => {
      emit("debug", m, f);
    },
    isEnabled: (lvl) => RANK[lvl] <= RANK[level],
    child: (b) => createLogger({ level, sink, bindings: { ...bindings, ...b } }),
  };
}

/** A logger that drops everything (tests, programmatic embedding). */
export const silentLogger: Logger = createLogger({ level: "error", sink: { write: () => undefined } });
