import { describe, expect, it } from "vitest";
import { ChatInputSchema, LIMITS } from "../../src/schemas/chat.js";
import { MetadataSchema, ModelIdSchema, RequestIdSchema } from "../../src/schemas/common.js";

const ok = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

describe("chat input schema", () => {
  it("accepts a minimal request and full options", () => {
    expect(ChatInputSchema.safeParse(ok).success).toBe(true);
    expect(
      ChatInputSchema.safeParse({
        ...ok,
        provider: "OPENAI",
        temperature: 0.7,
        max_tokens: 100,
        response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" } } },
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        metadata: { workflow_id: "wf_1", n: 2, flag: true },
        feature: "summarize",
        conversation_id: "conv:1",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", content: "42", tool_call_id: "c1" },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty messages", { ...ok, messages: [] }],
    ["unknown role", { ...ok, messages: [{ role: "root", content: "x" }] }],
    ["temperature out of range", { ...ok, temperature: 3 }],
    ["huge max_tokens", { ...ok, max_tokens: LIMITS.maxOutputTokens + 1 }],
    ["tool message without id", { ...ok, messages: [{ role: "tool", content: "x" }] }],
    ["null content on user", { ...ok, messages: [{ role: "user", content: null }] }],
    ["tool_calls on user", { ...ok, messages: [{ role: "user", content: "x", tool_calls: [] }] }],
    ["bad provider", { ...ok, provider: "COHERE" }],
    ["bad model id", { ...ok, model: "gpt-4o; rm -rf /" }],
    [
      "image parts are not supported",
      {
        ...ok,
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://x" } }] }],
      },
    ],
    [
      "oversized content",
      { ...ok, messages: [{ role: "user", content: "x".repeat(LIMITS.maxContentChars + 1) }] },
    ],
    [
      "too many messages",
      { ...ok, messages: new Array(LIMITS.maxMessages + 1).fill({ role: "user", content: "x" }) },
    ],
    [
      "total size",
      { ...ok, messages: new Array(3).fill({ role: "user", content: "x".repeat(LIMITS.maxContentChars) }) },
    ],
    ["bad response_format", { ...ok, response_format: { type: "xml" } }],
    ["bad function name", { ...ok, tools: [{ type: "function", function: { name: "a b" } }] }],
  ])("rejects %s", (_name, input) => {
    expect(ChatInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("metadata schema", () => {
  it("accepts flat primitives", () => {
    expect(MetadataSchema.safeParse({ a: "x", b: 1, c: false }).success).toBe(true);
  });
  it.each([
    ["nested object", { a: { b: 1 } }],
    ["array", { a: [1] }],
    ["null", { a: null }],
    ["too many keys", Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i]))],
    ["long value", { a: "x".repeat(513) }],
    ["bad key", { "bad key": 1 }],
  ])("rejects %s", (_n, v) => {
    expect(MetadataSchema.safeParse(v).success).toBe(false);
  });
});

describe("prototype pollution", () => {
  it("drops __proto__ keys without touching prototypes", () => {
    const r = MetadataSchema.safeParse(JSON.parse('{"__proto__": {"polluted": "yes"}, "a": "b"}'));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.keys(r.data)).toEqual(["a"]);
      expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("identifiers", () => {
  it("validates model and request ids", () => {
    expect(ModelIdSchema.safeParse("claude-sonnet-5").success).toBe(true);
    expect(ModelIdSchema.safeParse("models/gemini-2.5-flash").success).toBe(true);
    expect(RequestIdSchema.safeParse("732b1b59-495b-4308-b659-ddd47b1f1664").success).toBe(true);
    expect(RequestIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(RequestIdSchema.safeParse("a%2F..%2F").success).toBe(false);
  });
});
