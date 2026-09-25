import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, errorOf, text } from "../helpers/harness.js";
import {
  COMPLETION,
  DONE,
  KEY_A,
  KEY_SCOPED_MODELS,
  MockGateway,
  USAGE_CHUNK,
  chunk,
  json,
  sleep,
  sseHead,
} from "../helpers/mockGateway.js";

const gw = new MockGateway();
const MSG = [{ role: "user", content: "Say hello" }];

beforeAll(async () => {
  await gw.start();
});
afterAll(async () => {
  await gw.stop();
});
beforeEach(() => {
  gw.reset();
});

describe("protocol surface", () => {
  it("initializes and lists tools, resources, templates and prompts", async () => {
    const h = await connect(gw.url);
    expect(h.client.getServerVersion()).toMatchObject({ name: "modelgate", version: "0.1.0" });
    const tools = (await h.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "modelgate_chat",
      "modelgate_chat_stream",
      "modelgate_models",
      "modelgate_request",
      "modelgate_usage",
    ]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations).toBeDefined();
    }
    const chat = tools.find((t) => t.name === "modelgate_chat")!;
    expect(Object.keys(chat.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "model",
        "messages",
        "provider",
        "temperature",
        "max_tokens",
        "response_format",
        "tools",
        "metadata",
      ]),
    );
    expect(chat.outputSchema).toBeDefined();
    expect((await h.client.listResources()).resources.map((r) => r.uri).sort()).toEqual([
      "modelgate://integration",
      "modelgate://models",
    ]);
    expect((await h.client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate)).toEqual([
      "modelgate://requests/{request_id}",
    ]);
    expect((await h.client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual([
      "compare_models",
      "investigate_request",
      "usage_report",
    ]);
    await h.close();
  });

  it("renders prompts grounded in the modelgate tools", async () => {
    const h = await connect(gw.url);
    const p = await h.client.getPrompt({
      name: "investigate_request",
      arguments: { request_id: "projA-123456" },
    });
    const body = p.messages[0]?.content;
    expect(body?.type === "text" && body.text).toMatch(/modelgate_request/);
    const c = await h.client.getPrompt({
      name: "compare_models",
      arguments: { models: "a,b", prompt: "hi" },
    });
    expect(JSON.stringify(c)).toMatch(/modelgate_chat/);
    await h.close();
  });
});

describe("modelgate_chat", () => {
  it("runs inference with auth, attribution and request id", async () => {
    const h = await connect(gw.url, { environment: "test" });
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: {
        model: "gpt-4o-mini",
        messages: MSG,
        temperature: 0.2,
        max_tokens: 50,
        metadata: { workflow_id: "wf_9", source: "spoof" },
        feature: "greet",
      },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Hello from ModelGate");
    expect(r.structuredContent).toMatchObject({
      request_id: "req-1",
      content: "Hello from ModelGate",
      finish_reason: "stop",
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      streamed: false,
      complete: true,
    });
    const req = gw.last("/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(req.headers["x-modelgate-source"]).toBe("mcp");
    expect(req.headers["x-modelgate-integration"]).toBe("modelgate-mcp");
    expect(req.headers["x-modelgate-environment"]).toBe("test");
    expect(req.headers["x-modelgate-feature"]).toBe("greet");
    expect(String(req.headers["user-agent"])).toMatch(/^modelgate-mcp\/0\.1\.0/);
    const body = req.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 50,
      stream: false,
      messages: MSG,
    });
    expect(body.metadata).toMatchObject({
      source: "mcp",
      integration: "modelgate-mcp",
      mcp_client: "test-client",
      mcp_client_version: "1.2.3",
      mcp_tool: "modelgate_chat",
      mcp_transport: "stdio",
      workflow_id: "wf_9",
    });
    expect((body.metadata as Record<string, unknown>).correlation_id).toBe(
      (r.structuredContent as Record<string, unknown>).correlation_id,
    );
    // No unsupported fields are passed through.
    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "metadata",
      "model",
      "stream",
      "temperature",
    ]);
    await h.close();
  });

  it("uses the configured default model and provider", async () => {
    const h = await connect(gw.url, { defaultModel: "gpt-4o-mini", defaultProvider: "OPENAI" });
    const r = await h.client.callTool({ name: "modelgate_chat", arguments: { messages: MSG } });
    expect(r.isError).toBeFalsy();
    expect(gw.last().body).toMatchObject({ model: "gpt-4o-mini", provider: "OPENAI" });
    await h.close();
  });

  it("requires a model when no default is configured", async () => {
    const h = await connect(gw.url);
    const r = await h.client.callTool({ name: "modelgate_chat", arguments: { messages: MSG } });
    expect(errorOf(r).code).toBe("invalid_request");
    expect(gw.requests).toHaveLength(0);
    await h.close();
  });

  it("returns tool calls", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      json(res, 200, {
        ...COMPLETION,
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    });
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: {
        model: "gpt-4o-mini",
        messages: MSG,
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      },
    });
    expect(r.structuredContent).toMatchObject({
      content: null,
      finish_reason: "tool_calls",
      tool_calls: [{ id: "call_1" }],
    });
    expect(text(r)).toContain("get_weather");
    await h.close();
  });

  it("rejects schema-invalid input before calling ModelGate", async () => {
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: [{ role: "hacker", content: "x" }] },
    });
    expect(r.isError).toBe(true);
    expect(gw.requests).toHaveLength(0);
    await h.close();
  });

  it.each([
    ["invalid key", 401, { error: "invalid_api_key" }, "auth_invalid"],
    [
      "insufficient scope",
      403,
      { error: "insufficient_scope", required_scope: "inference:write" },
      "insufficient_scope",
    ],
    [
      "guardrail block",
      403,
      { error: "blocked_by_guardrails", category: "prompt_injection", score: 95 },
      "guardrail_blocked",
    ],
    [
      "invalid model",
      502,
      { error: "provider_error", provider_status: 404, retryable: false },
      "invalid_model",
    ],
    [
      "provider error",
      502,
      { error: "provider_error", provider_status: 500, retryable: true },
      "provider_error",
    ],
    ["quota", 402, { error: "monthly_quota_exceeded" }, "quota_exceeded"],
    ["too large", 413, { error: "prompt_too_large" }, "payload_too_large"],
    ["no provider", 400, { error: "provider_required" }, "provider_required"],
  ])("maps %s", async (_n, status, body, code) => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      json(res, status, body, { "x-modelgate-request-id": "rid-err" });
    });
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    const e = errorOf(r);
    expect(e.code).toBe(code);
    expect(e.request_id).toBe("rid-err");
    expect(gw.requests).toHaveLength(1); // none of these are retried
    await h.close();
  });

  it("uses a real scoped key and surfaces insufficient_scope from ModelGate", async () => {
    const h = await connect(gw.url, { apiKey: KEY_SCOPED_MODELS });
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    expect(errorOf(r)).toMatchObject({
      code: "insufficient_scope",
      details: { required_scope: "inference:write" },
    });
    const m = await h.client.callTool({ name: "modelgate_models", arguments: {} });
    expect(m.isError).toBeFalsy();
    await h.close();
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    let n = 0;
    gw.on("POST /v1/chat/completions", (_req, res) => {
      if (++n === 1) {
        json(res, 429, { error: "rate_limited" }, { "retry-after": "1" });
        return;
      }
      json(res, 200, COMPLETION, { "x-modelgate-request-id": "rid-ok" });
    });
    const h = await connect(gw.url);
    const t0 = Date.now();
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    expect(r.isError).toBeFalsy();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(gw.requests).toHaveLength(2);
    await h.close();
  });

  it("gives up on persistent 429 with a retryable error", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      json(res, 429, { error: "rate_limited" }, { "retry-after": "0" });
    });
    const h = await connect(gw.url, { maxRetries: 2 });
    const e = errorOf(
      await h.client.callTool({ name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } }),
    );
    expect(e).toMatchObject({ code: "rate_limited", retryable: true });
    expect(gw.requests).toHaveLength(3);
    await h.close();
  });

  it("never retries inference on 5xx (possible duplicate billing)", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      json(res, 500, { error: "internal_error" });
    });
    const h = await connect(gw.url);
    expect(
      errorOf(
        await h.client.callTool({
          name: "modelgate_chat",
          arguments: { model: "gpt-4o-mini", messages: MSG },
        }),
      ).code,
    ).toBe("gateway_error");
    expect(gw.requests).toHaveLength(1);
    await h.close();
  });

  it("times out a hung gateway with gateway_timeout", async () => {
    gw.on("POST /v1/chat/completions", async (_req, res) => {
      await sleep(3_000);
      json(res, 200, COMPLETION);
    });
    const h = await connect(gw.url, { timeoutMs: 1_000 });
    const e = errorOf(
      await h.client.callTool({ name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } }),
    );
    expect(e.code).toBe("gateway_timeout");
    expect(gw.requests).toHaveLength(1);
    await h.close();
  });

  it("cancellation aborts the upstream request", async () => {
    gw.on("POST /v1/chat/completions", async (_req, res) => {
      await sleep(5_000);
      json(res, 200, COMPLETION);
    });
    const h = await connect(gw.url);
    const ac = new AbortController();
    const call = h.client.callTool(
      { name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } },
      { signal: ac.signal },
    );
    await sleep(300);
    ac.abort();
    await expect(call).rejects.toThrow();
    expect(await gw.last().aborted).toBe(true);
    await h.close();
  });

  it.each([
    ["non-JSON body", "<html>oops</html>"],
    ["missing choices", JSON.stringify({ id: "x" })],
    ["wrong types", JSON.stringify({ choices: [{ message: { content: 42 } }] })],
  ])("reports a malformed upstream response: %s", async (_n, payload) => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-modelgate-request-id": "rid-bad" });
      res.end(payload);
    });
    const h = await connect(gw.url);
    const e = errorOf(
      await h.client.callTool({ name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } }),
    );
    expect(e).toMatchObject({ code: "malformed_response", request_id: "rid-bad" });
    await h.close();
  });

  it("refuses redirects so the key is never forwarded", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      res.writeHead(307, { location: "https://evil.example.com/steal" });
      res.end();
    });
    const h = await connect(gw.url);
    const e = errorOf(
      await h.client.callTool({ name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } }),
    );
    expect(e.code).toBe("network_error");
    expect(gw.requests).toHaveLength(1);
    await h.close();
  });

  it("truncates oversized model output", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      json(res, 200, {
        ...COMPLETION,
        choices: [{ message: { role: "assistant", content: "x".repeat(5_000) }, finish_reason: "stop" }],
      });
    });
    const h = await connect(gw.url, { maxOutputChars: 1_000 });
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    expect((r.structuredContent as { content: string }).content).toHaveLength(1_000);
    expect(r.structuredContent).toMatchObject({ truncated: true });
    await h.close();
  });

  it("reports network failures", async () => {
    const h = await connect("http://127.0.0.1:9", { maxRetries: 0 });
    const e = errorOf(
      await h.client.callTool({ name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } }),
    );
    expect(e.code).toBe("network_error");
    await h.close();
  });
});

describe("modelgate_chat_stream", () => {
  it("streams real deltas as progress notifications and returns final usage", async () => {
    const h = await connect(gw.url);
    const progress: string[] = [];
    const r = await h.client.callTool(
      { name: "modelgate_chat_stream", arguments: { model: "gpt-4o-mini", messages: MSG } },
      { onprogress: (p) => progress.push(String(p.message)) },
    );
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      content: "Hello",
      streamed: true,
      complete: true,
      finish_reason: "stop",
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(progress.join("")).toBe("Hello");
    expect(gw.last().body).toMatchObject({ stream: true });
    expect(gw.last().headers.accept).toBe("text/event-stream");
    await h.close();
  });

  it("delivers deltas incrementally, before the stream ends", async () => {
    gw.on("POST /v1/chat/completions", async (_req, res) => {
      sseHead(res);
      for (const part of ["one ", "two ", "three"]) {
        res.write(chunk(part));
        await sleep(250);
      }
      res.write(USAGE_CHUNK);
      res.end(DONE);
    });
    const h = await connect(gw.url);
    const times: number[] = [];
    const t0 = Date.now();
    await h.client.callTool(
      { name: "modelgate_chat_stream", arguments: { model: "gpt-4o-mini", messages: MSG } },
      { onprogress: () => times.push(Date.now() - t0) },
    );
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times[0]!).toBeLessThan(500); // first delta arrived long before the ~750 ms stream finished
    await h.close();
  });

  it("marks a stream that ends without usage as incomplete (partial failure)", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      sseHead(res);
      res.write(chunk("partial"));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end(DONE);
    });
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat_stream",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    expect(r.structuredContent).toMatchObject({ content: "partial", complete: false, usage: null });
    expect(text(r)).toMatch(/WARNING/);
    await h.close();
  });

  it("handles an upstream disconnect mid-stream", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      sseHead(res);
      res.write(chunk("half"));
      setTimeout(() => res.destroy(), 50);
    });
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat_stream",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    if (r.isError) expect(errorOf(r).code).toBe("network_error");
    else expect(r.structuredContent).toMatchObject({ complete: false });
    await h.close();
  });

  it("times out a stalled stream (idle timeout)", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      sseHead(res);
      res.write(chunk("stuck"));
    });
    const h = await connect(gw.url, { timeoutMs: 1_000 });
    const e = errorOf(
      await h.client.callTool({
        name: "modelgate_chat_stream",
        arguments: { model: "gpt-4o-mini", messages: MSG },
      }),
    );
    expect(e.code).toBe("gateway_timeout");
    await h.close();
  });

  it("does not cut off a long stream that keeps producing", async () => {
    gw.on("POST /v1/chat/completions", async (_req, res) => {
      sseHead(res);
      for (let i = 0; i < 6; i++) {
        res.write(chunk(`${i}`));
        await sleep(300);
      }
      res.write(USAGE_CHUNK);
      res.end(DONE);
    });
    const h = await connect(gw.url, { timeoutMs: 1_000 });
    const r = await h.client.callTool({
      name: "modelgate_chat_stream",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    expect(r.structuredContent).toMatchObject({ content: "012345", complete: true });
    await h.close();
  });

  it("cancellation closes the upstream stream", async () => {
    gw.on("POST /v1/chat/completions", async (_req, res) => {
      sseHead(res);
      for (let i = 0; i < 50; i++) {
        if (res.destroyed) return;
        res.write(chunk("tok "));
        await sleep(100);
      }
      res.end(DONE);
    });
    const h = await connect(gw.url);
    const ac = new AbortController();
    const call = h.client.callTool(
      { name: "modelgate_chat_stream", arguments: { model: "gpt-4o-mini", messages: MSG } },
      { signal: ac.signal, onprogress: () => undefined },
    );
    await sleep(400);
    ac.abort();
    await expect(call).rejects.toThrow();
    expect(await gw.last().aborted).toBe(true);
    await h.close();
  });

  it("rejects malformed chunks", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      sseHead(res);
      res.end("data: {not json}\n\n");
    });
    const h = await connect(gw.url);
    expect(
      errorOf(
        await h.client.callTool({
          name: "modelgate_chat_stream",
          arguments: { model: "gpt-4o-mini", messages: MSG },
        }),
      ).code,
    ).toBe("malformed_response");
    await h.close();
  });

  it("maps a 409 stream conflict", async () => {
    gw.on("POST /v1/chat/completions", (_req, res) => {
      json(res, 409, { error: "stream_enforce_conflict" });
    });
    const h = await connect(gw.url);
    expect(
      errorOf(
        await h.client.callTool({
          name: "modelgate_chat_stream",
          arguments: { model: "gpt-4o-mini", messages: MSG },
        }),
      ).code,
    ).toBe("stream_unavailable");
    await h.close();
  });

  it("refuses tools (ModelGate streams text only)", async () => {
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat_stream",
      arguments: {
        model: "gpt-4o-mini",
        messages: MSG,
        tools: [{ type: "function", function: { name: "f" } }],
      },
    });
    expect(errorOf(r).code).toBe("invalid_request");
    expect(gw.requests).toHaveLength(0);
    await h.close();
  });
});

describe("read tools", () => {
  it("modelgate_models lists models dynamically", async () => {
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_models",
      arguments: { provider: "OPENAI", available_only: true },
    });
    expect(r.structuredContent).toMatchObject({
      count: 2,
      default_provider: "OPENAI",
      configured_providers: ["OPENAI"],
    });
    expect(gw.last().query.get("provider")).toBe("OPENAI");
    expect(gw.last().query.get("available")).toBe("true");
    expect(text(r)).toMatch(/claude-haiku-4-5 \(ANTHROPIC\) — provider not configured/);
    await h.close();
  });

  it("modelgate_usage passes filters and period", async () => {
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_usage",
      arguments: { period: "7d", source: "mcp", group_by: "model" },
    });
    expect(r.isError).toBeFalsy();
    const q = gw.last().query;
    expect(q.get("source")).toBe("mcp");
    expect(q.get("group_by")).toBe("model");
    const span = Date.parse(q.get("to")!) - Date.parse(q.get("from")!);
    expect(Math.round(span / 86_400_000)).toBe(7);
    expect(r.structuredContent).toMatchObject({
      totals: { requests: 3, cost_usd: "0.000100" },
      group_by: "model",
    });
    await h.close();
  });

  it("modelgate_usage validates windows locally", async () => {
    const h = await connect(gw.url);
    const r1 = await h.client.callTool({
      name: "modelgate_usage",
      arguments: { period: "7d", from: "2026-01-01T00:00:00Z" },
    });
    expect(r1.isError).toBe(true);
    const r2 = await h.client.callTool({
      name: "modelgate_usage",
      arguments: { from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
    });
    expect(errorOf(r2).code).toBe("invalid_request");
    expect(gw.requests).toHaveLength(0);
    await h.close();
  });

  it("modelgate_usage retries a transient 503 (idempotent read)", async () => {
    let n = 0;
    gw.on("GET /v1/usage", (_req, res) => {
      if (++n === 1) {
        json(res, 503, {});
        return;
      }
      json(res, 200, {
        object: "usage",
        from: "a",
        to: "b",
        totals: { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: "0" },
      });
    });
    const h = await connect(gw.url);
    expect((await h.client.callTool({ name: "modelgate_usage", arguments: {} })).isError).toBeFalsy();
    expect(gw.requests).toHaveLength(2);
    await h.close();
  });

  it("modelgate_request returns the project's own request and 404s another project's", async () => {
    const h = await connect(gw.url);
    const own = await h.client.callTool({
      name: "modelgate_request",
      arguments: { request_id: "projA-0001" },
    });
    expect(own.structuredContent).toMatchObject({ id: "projA-0001", status: "OK", request_id: "projA-0001" });
    expect(text(own)).toMatch(/tokens: 20/);
    const other = await h.client.callTool({
      name: "modelgate_request",
      arguments: { request_id: "projB-0001" },
    });
    expect(errorOf(other).code).toBe("not_found");
    const traversal = await h.client.callTool({
      name: "modelgate_request",
      arguments: { request_id: "../v1/me" },
    });
    expect(traversal.isError).toBe(true);
    expect(gw.requests.map((r) => r.path)).toEqual(["/v1/requests/projA-0001", "/v1/requests/projB-0001"]);
    await h.close();
  });

  it("reports endpoint_unavailable against a gateway without the integration API", async () => {
    gw.on("GET /v1/models", (_req, res) => {
      json(res, 404, { message: "Route GET:/v1/models not found", error: "Not Found" });
    });
    const h = await connect(gw.url);
    const e = errorOf(await h.client.callTool({ name: "modelgate_models", arguments: {} }));
    expect(e.code).toBe("endpoint_unavailable");
    expect(gw.requests).toHaveLength(1);
    await h.close();
  });
});

describe("resources", () => {
  it("reads models, integration info and request records", async () => {
    const h = await connect(gw.url);
    const models = await h.client.readResource({ uri: "modelgate://models" });
    expect(JSON.parse((models.contents[0] as { text: string }).text)).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: "gpt-4o-mini" })]),
    });
    const integ = await h.client.readResource({ uri: "modelgate://integration" });
    const body = (integ.contents[0] as { text: string }).text;
    expect(JSON.parse(body)).toMatchObject({
      server: { name: "modelgate-mcp" },
      modelgate_key: { project: { id: "projA" } },
    });
    expect(body).not.toContain(KEY_A);
    const reqRes = await h.client.readResource({ uri: "modelgate://requests/projA-42424242" });
    expect(JSON.parse((reqRes.contents[0] as { text: string }).text)).toMatchObject({ id: "projA-42424242" });
    await expect(h.client.readResource({ uri: "modelgate://requests/projB-42424242" })).rejects.toThrow(
      /not_found/,
    );
    await h.close();
  });
});

describe("secret hygiene", () => {
  it("never puts the API key in results, errors or logs", async () => {
    gw.on("POST /v1/chat/completions", (req, res) => {
      // A hostile upstream echoing the credential back must not leak it.
      json(res, 500, { error: "internal_error", message: `bad key ${String(req.headers.authorization)}` });
    });
    const h = await connect(gw.url);
    const r = await h.client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: MSG },
    });
    await h.client.callTool({ name: "modelgate_models", arguments: {} });
    expect(JSON.stringify(r)).not.toContain(KEY_A);
    expect(h.logs.text()).not.toContain(KEY_A);
    expect(h.logs.text()).not.toContain("Say hello"); // content is not logged by default
    await h.close();
  });

  it("logs content only with MODELGATE_LOG_CONTENT", async () => {
    const h = await connect(gw.url, { logContent: true });
    await h.client.callTool({ name: "modelgate_chat", arguments: { model: "gpt-4o-mini", messages: MSG } });
    expect(h.logs.text()).toContain("Say hello");
    expect(h.logs.text()).not.toContain(KEY_A);
    await h.close();
  });
});
