#!/usr/bin/env node
// Live end-to-end check against a real ModelGate deployment.
//
//   MODELGATE_KEY=mg_... npm run test:live
//
// Optional:
//   MODELGATE_BASE_URL   default https://gw.modelgatehq.com
//   MODELGATE_E2E_MODEL  default gpt-4o-mini (one short, ~sub-cent call + one stream)
//
// Spawns the built server (dist/cli.js) over stdio exactly like an MCP client
// and verifies: startup, initialize, tool discovery, models, a real chat
// request, streaming, token usage, the ModelGate request id, MCP attribution,
// the request record in ModelGate, safe failure with a bad key, and that no
// secret appears in any output. Makes only normal inference/usage records.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const KEY = process.env.MODELGATE_KEY ?? process.env.MODELGATE_API_KEY;
const BASE = process.env.MODELGATE_BASE_URL ?? "https://gw.modelgatehq.com";
const MODEL = process.env.MODELGATE_E2E_MODEL ?? "gpt-4o-mini";

if (!KEY) {
  console.error("MODELGATE_KEY is required (use an integration-scoped key).");
  process.exit(2);
}

const results = [];
const record = (name, status, detail = "") => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
};
const errOf = (r) => {
  try {
    return JSON.parse(r.content.at(-1).text).error;
  } catch {
    return { code: "unknown" };
  }
};

async function connect(key) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: {
      PATH: process.env.PATH ?? "",
      MODELGATE_KEY: key,
      MODELGATE_BASE_URL: BASE,
      MODELGATE_LOG_LEVEL: "debug",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "modelgate-mcp-live-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const outputs = [];
let s;
try {
  s = await connect(KEY);
  record("1. server starts", "PASS");
  record("2. client initializes", "PASS", JSON.stringify(s.client.getServerVersion()));
} catch (e) {
  record("1-2. start/initialize", "FAIL", e.message);
  process.exit(1);
}

const tools = (await s.client.listTools()).tools.map((t) => t.name);
record("3. tools discoverable", tools.length === 5 ? "PASS" : "FAIL", tools.join(", "));

const models = await s.client.callTool({ name: "modelgate_models", arguments: {} });
outputs.push(models);
if (!models.isError) record("4. models retrieved", "PASS", `${models.structuredContent.count} models`);
else if (errOf(models).code === "endpoint_unavailable")
  record(
    "4. models retrieved",
    "SKIP",
    "gateway lacks GET /v1/models (deploy the ModelGate integration API)",
  );
else record("4. models retrieved", "FAIL", errOf(models).code);

const chat = await s.client.callTool({
  name: "modelgate_chat",
  arguments: {
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    max_tokens: 16,
    metadata: { e2e: "live" },
  },
});
outputs.push(chat);
const c = chat.structuredContent ?? {};
record(
  "5. real chat request",
  chat.isError ? "FAIL" : "PASS",
  chat.isError ? `${errOf(chat).code}: ${errOf(chat).message}` : JSON.stringify(c.content),
);

const progress = [];
const stream = await s.client.callTool(
  {
    name: "modelgate_chat_stream",
    arguments: { model: MODEL, messages: [{ role: "user", content: "Count from 1 to 5." }], max_tokens: 40 },
  },
  { onprogress: (p) => progress.push(p.message) },
);
outputs.push(stream);
const sc = stream.structuredContent ?? {};
record(
  "6. streaming",
  !stream.isError && sc.complete && progress.length > 0 ? "PASS" : "FAIL",
  stream.isError ? errOf(stream).code : `${progress.length} progress notifications, complete=${sc.complete}`,
);

record(
  "7. usage/tokens captured",
  c.usage?.total_tokens > 0 ? "PASS" : "FAIL",
  JSON.stringify(c.usage ?? null),
);
record(
  "8. ModelGate request id returned",
  typeof c.request_id === "string" && c.request_id.length > 8 ? "PASS" : "FAIL",
  c.request_id ?? "none",
);

if (c.request_id) {
  const rec = await s.client.callTool({ name: "modelgate_request", arguments: { request_id: c.request_id } });
  outputs.push(rec);
  if (rec.isError && errOf(rec).code === "endpoint_unavailable") {
    record(
      "9. attribution identifies MCP",
      "SKIP",
      "gateway lacks GET /v1/requests/:id — verify source=mcp in the dashboard Requests view",
    );
    record(
      "10. request visible in observability",
      "SKIP",
      `look up ${c.request_id} in the ModelGate dashboard`,
    );
  } else if (rec.isError) {
    record("9-10. request lookup", "FAIL", errOf(rec).code);
  } else {
    const r = rec.structuredContent;
    record(
      "9. attribution identifies MCP",
      r.source === "mcp" && r.metadata?.integration === "modelgate-mcp" ? "PASS" : "FAIL",
      JSON.stringify({
        source: r.source,
        integration: r.metadata?.integration,
        mcp_client: r.metadata?.mcp_client,
        correlation_id: r.metadata?.correlation_id === c.correlation_id,
      }),
    );
    record(
      "10. request visible in observability",
      r.status === "OK" ? "PASS" : "FAIL",
      `status=${r.status} tokens=${r.usage?.total_tokens} cost=$${r.cost_usd} latency=${r.latency_ms}ms`,
    );
  }
}

const usage = await s.client.callTool({
  name: "modelgate_usage",
  arguments: { period: "24h", source: "mcp" },
});
outputs.push(usage);
if (!usage.isError)
  record("   usage report (source=mcp, 24h)", "PASS", JSON.stringify(usage.structuredContent.totals));
else
  record(
    "   usage report",
    errOf(usage).code === "endpoint_unavailable" ? "SKIP" : "FAIL",
    errOf(usage).code,
  );
await s.client.close();

const badKey = `mg_invalidkey00_${"x".repeat(43)}`;
const bad = await connect(badKey);
const badRes = await bad.client.callTool({
  name: "modelgate_chat",
  arguments: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
});
outputs.push(badRes);
record(
  "11. invalid credentials fail safely",
  badRes.isError && errOf(badRes).code === "auth_invalid" ? "PASS" : "FAIL",
  errOf(badRes).code,
);
await bad.client.close();

const everything = JSON.stringify(outputs) + s.stderr() + bad.stderr();
const leaked = everything.includes(KEY) || everything.includes(badKey);
record("12. no secrets in logs/errors/results", leaked ? "FAIL" : "PASS");

const failed = results.filter((r) => r.status === "FAIL");
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed or skipped; ${failed.length} failed.`,
);
process.exit(failed.length ? 1 : 0);
