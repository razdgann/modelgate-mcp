// Secret redaction for everything that leaves the process as text: logs and
// error messages. Two layers: pattern-based (ModelGate keys, bearer tokens,
// common provider key shapes) and exact-value (secrets registered at startup,
// e.g. the configured ModelGate key and remote auth tokens).

const PATTERNS: Array<[RegExp, string]> = [
  // ModelGate keys: mg_<id>_<random>
  [/mg_[A-Za-z0-9_-]{6,}/g, "mg_[REDACTED]"],
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // Common provider key shapes (OpenAI/Anthropic sk-..., Google AIza...)
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "AIza[REDACTED]"],
];

const SENSITIVE_KEY =
  /(authorization|api[-_]?key|apikey|x-api-key|token|secret|password|passwd|cookie|credential)/i;

const registered = new Set<string>();

/** Register an exact secret value so it is scrubbed wherever it appears. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) registered.add(value);
}

/** Test hook: forget registered secrets. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_KEYS = 50;
const MAX_STRING = 4_000;

/**
 * Deep-copy a value into a JSON-safe, redacted form: sensitive keys are
 * masked, strings are scrubbed and truncated, depth/breadth are bounded, and
 * prototype-polluting keys are dropped. Never throws.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const s = redactString(value);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1));
    if (value.length > MAX_ARRAY) arr.push(`[+${value.length - MAX_ARRAY} more]`);
    return arr;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (n++ >= MAX_KEYS) {
      out["…"] = "[truncated]";
      break;
    }
    out[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}
