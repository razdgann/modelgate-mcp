import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging/logger.js";
import { redactString, redactValue, registerSecret } from "../../src/logging/redact.js";

describe("redaction", () => {
  it("scrubs ModelGate keys, bearer tokens and provider keys", () => {
    const s = redactString(
      "key mg_cabc123_ZZZZZZZZZZZZ Authorization: Bearer abcdefghijklmnop sk-proj-1234567890abcdefghij AIzaSyA1234567890abcdefghijk",
    );
    expect(s).not.toMatch(/ZZZZ|abcdefghijklmnop|1234567890abcdefghij|SyA1234567890/);
  });

  it("masks sensitive keys deeply and drops prototype keys", () => {
    const v = redactValue({
      headers: { Authorization: "Bearer x", "x-api-key": "y", accept: "json" },
      nested: { apiKey: "z", password: "p", ok: 1 },
      ["__proto__"]: { polluted: true },
    }) as Record<string, Record<string, unknown>>;
    expect(v.headers).toEqual({ Authorization: "[REDACTED]", "x-api-key": "[REDACTED]", accept: "json" });
    expect(v.nested).toEqual({ apiKey: "[REDACTED]", password: "[REDACTED]", ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds depth, arrays and strings", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i++) deep = deep.n = {};
    expect(JSON.stringify(redactValue(root))).toContain("[depth-limit]");
    expect((redactValue(new Array(500).fill(1)) as unknown[]).length).toBe(51);
    expect((redactValue("x".repeat(10_000)) as string).length).toBeLessThan(4_100);
  });

  it("redacts registered exact secrets", () => {
    registerSecret("super-secret-token-value-123");
    expect(redactString("t=super-secret-token-value-123")).toBe("t=[REDACTED]");
  });

  it("serializes errors without stacks", () => {
    const v = redactValue(new Error("boom mg_cid_secretvalue123")) as Record<string, unknown>;
    expect(v).toEqual({ name: "Error", message: "boom mg_[REDACTED]" });
  });
});

describe("logger", () => {
  it("writes one JSON line per record, redacted, filtered by level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", sink: { write: (l: string) => lines.push(l) } });
    log.debug("hidden");
    log.info('hello\nfake {"level":"error"}', {
      authorization: "Bearer abcdefghijkl",
      key: "mg_cid_secretvalue123",
    });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n"); // log injection: newline stays escaped inside JSON
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec.level).toBe("info");
    expect(rec.authorization).toBe("[REDACTED]");
    expect(line).not.toContain("secretvalue123");
  });

  it("child loggers carry bindings", () => {
    const lines: string[] = [];
    createLogger({ sink: { write: (l: string) => lines.push(l) } })
      .child({ tool: "t" })
      .warn("w");
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: "t", level: "warn", msg: "w" });
  });
});
