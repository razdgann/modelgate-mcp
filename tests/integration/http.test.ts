import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type ConfigOverrides } from "../../src/config/config.js";
import { startHttp, type RunningHttpServer } from "../../src/transports/http.js";
import { captureLogs } from "../helpers/harness.js";
import { KEY_A, KEY_B, MockGateway } from "../helpers/mockGateway.js";

const gw = new MockGateway();
let running: RunningHttpServer | undefined;
const logs = captureLogs();

beforeAll(async () => {
  await gw.start();
});
afterAll(async () => {
  await gw.stop();
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  gw.reset();
});

async function start(env: Record<string, string> = {}, overrides: ConfigOverrides = {}) {
  const config = loadConfig({
    mode: "http",
    env: { MODELGATE_BASE_URL: gw.url, MODELGATE_ALLOW_CUSTOM_BASE_URL: "true", ...env },
    overrides: { timeoutMs: 5_000, ...overrides, http: { port: 0, ...overrides.http } },
  });
  running = await startHttp(config, logs.logger);
  return running.url;
}

async function mcpClient(url: string, token: string, modern = false) {
  const client = new Client(
    { name: "remote-test", version: "0.0.1" },
    modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});
const post = (url: string, headers: Record<string, string>, body = initBody) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });

describe("remote MCP (streamable HTTP)", () => {
  it("serves health without auth", async () => {
    const url = await start();
    const res = await fetch(url.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "modelgate-mcp" });
  });

  it("rejects unauthenticated requests with 401 + WWW-Authenticate", async () => {
    const url = await start();
    const res = await post(url, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(gw.requests).toHaveLength(0);
    const bad = await post(url, { authorization: "Bearer not-a-modelgate-key" });
    expect(bad.status).toBe(401);
  });

  it("verifies passthrough keys with ModelGate and rejects revoked/invalid ones", async () => {
    const url = await start();
    const res = await post(url, { authorization: `Bearer mg_revokedkey_${"z".repeat(40)}` });
    expect(res.status).toBe(401);
    expect(gw.last().path).toBe("/v1/me");
  });

  it("passthrough: each caller runs as its own ModelGate key (tenant isolation)", async () => {
    const url = await start();
    const a = await mcpClient(url, KEY_A);
    const b = await mcpClient(url, KEY_B, true);
    const ra = await a.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "a" }] },
    });
    const rb = await b.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "b" }] },
    });
    expect(ra.isError).toBeFalsy();
    expect(rb.isError).toBeFalsy();
    const chats = gw.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(chats.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    expect(chats[0]!.body).toMatchObject({ metadata: { source: "mcp", mcp_transport: "http" } });
    // Stateless HTTP: a 2025-era client's identity only exists in its initialize
    // request, so it cannot be attributed; 2026-07-28 clients send it per request.
    expect((chats[0]!.body as { metadata: Record<string, unknown> }).metadata.mcp_client).toBeUndefined();
    expect(chats[1]!.body).toMatchObject({
      metadata: { mcp_client: "remote-test", mcp_client_version: "0.0.1" },
    });
    // B cannot read A's request: the lookup runs with B's key and ModelGate answers 404.
    const cross = await b.callTool({ name: "modelgate_request", arguments: { request_id: "projA-0001" } });
    expect(cross.isError).toBe(true);
    expect(gw.last().headers.authorization).toBe(`Bearer ${KEY_B}`);
    await a.close();
    await b.close();
  });

  it("streams over HTTP with progress", async () => {
    const url = await start();
    const c = await mcpClient(url, KEY_A, true);
    const progress: string[] = [];
    const r = await c.callTool(
      {
        name: "modelgate_chat_stream",
        arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] },
      },
      { onprogress: (p) => progress.push(String(p.message)) },
    );
    expect(r.structuredContent).toMatchObject({ content: "Hello", complete: true });
    expect(progress.join("")).toBe("Hello");
    await c.close();
  });

  it("token mode: clients use the shared token; upstream uses the server key", async () => {
    const token = "s".repeat(40);
    const url = await start({
      MODELGATE_MCP_AUTH: "token",
      MODELGATE_MCP_AUTH_TOKENS: token,
      MODELGATE_KEY: KEY_A,
    });
    expect((await post(url, { authorization: `Bearer ${KEY_B}` })).status).toBe(401);
    const c = await mcpClient(url, token);
    await c.callTool({ name: "modelgate_models", arguments: {} });
    expect(gw.last().headers.authorization).toBe(`Bearer ${KEY_A}`);
    await c.close();
  });

  it("blocks DNS-rebinding hosts and foreign origins", async () => {
    const url = await start();
    const auth = { authorization: `Bearer ${KEY_A}` };
    const u = new URL(url);
    const badHost = await new Promise<number>((resolve, reject) => {
      // fetch() forbids overriding Host, so use node:http directly.
      void import("node:http").then(({ request }) => {
        const r = request(
          {
            host: u.hostname,
            port: u.port,
            path: "/mcp",
            method: "POST",
            headers: { host: "evil.example.com", "content-type": "application/json", ...auth },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        r.on("error", reject);
        r.end(initBody);
      });
    });
    expect(badHost).toBe(403);
    expect((await post(url, { ...auth, origin: "https://evil.example.com" })).status).toBe(403);
    expect((await post(url, { ...auth, origin: "http://localhost:5173" })).status).not.toBe(403);
  });

  it("rate limits per principal", async () => {
    const url = await start({}, { http: { rateLimitPerMinute: 3 } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(url, { authorization: `Bearer ${KEY_A}` })).status);
    expect(codes.slice(3)).toEqual([429, 429]);
    // Another principal is unaffected.
    expect((await post(url, { authorization: `Bearer ${KEY_B}` })).status).not.toBe(429);
  });

  it("rejects oversized bodies with 413", async () => {
    const url = await start({}, { http: { maxBodyBytes: 2_048 } });
    const res = await post(
      url,
      { authorization: `Bearer ${KEY_A}` },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(10_000) } }),
    );
    expect(res.status).toBe(413);
  });

  it("404s unknown paths and shuts down cleanly", async () => {
    const url = await start();
    expect((await fetch(url.replace("/mcp", "/admin"))).status).toBe(404);
    await running!.close();
    running = undefined;
    await expect(fetch(url.replace("/mcp", "/healthz"))).rejects.toThrow();
  });

  it("never logs keys or tokens", () => {
    expect(logs.text()).not.toContain(KEY_A);
    expect(logs.text()).not.toContain(KEY_B);
    expect(logs.text()).not.toContain("s".repeat(40));
  });
});
