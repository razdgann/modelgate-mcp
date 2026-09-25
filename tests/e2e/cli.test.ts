import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_A, MockGateway } from "../helpers/mockGateway.js";

// Runs the *built* CLI (dist/cli.js) as a child process, exactly as an MCP
// client would launch it. `npm run test:e2e` builds first.

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const gw = new MockGateway();

beforeAll(async () => {
  await gw.start();
});
afterAll(async () => {
  await gw.stop();
});

const baseEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "",
  MODELGATE_BASE_URL: gw.url,
  ...extra,
});

// Async (not spawnSync): the mock gateway runs in this process and must keep serving.
function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const t = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("exit", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("CLI", () => {
  it("--version and --help", async () => {
    const v = await run(["--version"], baseEnv());
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe("0.1.0");
    const h = await run(["--help"], baseEnv());
    expect(h.status).toBe(0);
    expect(h.stdout).toMatch(/modelgate-mcp \[stdio\]/);
    expect(h.stdout).toMatch(/MODELGATE_KEY/);
  });

  it("fails fast with an actionable error when the key is missing", async () => {
    const r = await run([], baseEnv());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/MODELGATE_KEY is not set/);
  });

  it("rejects unknown commands", async () => {
    const r = await run(["serve-everything"], baseEnv({ MODELGATE_KEY: KEY_A }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command/);
  });

  it("check validates config and the key without printing it", async () => {
    const r = await run(["check"], baseEnv({ MODELGATE_KEY: KEY_A }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/configuration: OK/);
    expect(r.stdout).toMatch(/reachable/);
    expect(r.stdout).toMatch(/API key: valid — project "projA name"/);
    expect(r.stdout + r.stderr).not.toContain(KEY_A);
    const bad = await run(["check"], baseEnv({ MODELGATE_KEY: `mg_wrongkey_${"q".repeat(40)}` }));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/API key: FAILED \[auth_invalid\]/);
  });
});

describe("stdio server (child process)", () => {
  it("keeps stdout pure JSON-RPC while logging to stderr", async () => {
    const child = spawn(process.execPath, [CLI], {
      env: baseEnv({ MODELGATE_KEY: KEY_A, MODELGATE_LOG_LEVEL: "debug" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "modelgate_models", arguments: {} },
    });
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('"id":2') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: "2.0" });
    expect(stderr).toMatch(/"level":"info"/);
    expect(stdout + stderr).not.toContain(KEY_A);
  });

  it("serves the full tool surface to an SDK client", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: baseEnv({ MODELGATE_KEY: KEY_A }),
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e-client", version: "3.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(5);
    const chat = await client.callTool({
      name: "modelgate_chat",
      arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chat.structuredContent).toMatchObject({
      content: "Hello from ModelGate",
      request_id: expect.any(String),
    });
    expect(gw.last("/v1/chat/completions").body).toMatchObject({
      metadata: { source: "mcp", mcp_client: "e2e-client", mcp_transport: "stdio" },
    });
    const stream = await client.callTool({
      name: "modelgate_chat_stream",
      arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });
    expect(stream.structuredContent).toMatchObject({ content: "Hello", complete: true });
    await client.close();
  });

  it("negotiates the 2026-07-28 protocol too", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: baseEnv({ MODELGATE_KEY: KEY_A }),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "modern-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    const r = await client.callTool({ name: "modelgate_models", arguments: {} });
    expect(r.isError).toBeFalsy();
    await client.close();
  });
});

describe("http server (child process)", () => {
  it("starts, serves an authenticated client, and exits on SIGTERM", async () => {
    const child = spawn(process.execPath, [CLI, "http", "--port", "0"], {
      env: baseEnv({ MODELGATE_ALLOW_CUSTOM_BASE_URL: "true" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`no listen line: ${stderr}`));
      }, 10_000);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        const m = /"url":"(http:\/\/[^"]+)"/.exec(stderr);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    const client = new Client({ name: "remote", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${KEY_A}` } },
      }),
    );
    const r = await client.callTool({ name: "modelgate_usage", arguments: { period: "24h" } });
    expect(r.isError).toBeFalsy();
    await client.close();
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(0);
    expect(stderr).toMatch(/shutting down/);
    expect(stderr).not.toContain(KEY_A);
  });
});
