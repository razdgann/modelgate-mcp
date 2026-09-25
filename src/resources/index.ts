import { ResourceTemplate, type McpServer, type ReadResourceResult } from "@modelcontextprotocol/server";
import { describeConfig } from "../config/config.js";
import { ModelGateMcpError } from "../errors/errors.js";
import { normalizeError } from "../errors/toolResult.js";
import { getMe, getRequest, listModels } from "../modelgate/api.js";
import { RequestIdSchema } from "../schemas/common.js";
import type { ToolEnv } from "../tools/context.js";
import { PACKAGE_NAME, VERSION } from "../version.js";

// Read-only ModelGate context as MCP resources: things a client may want to
// attach to a conversation (the model catalog, what this connection is
// allowed to do, one request's record) rather than actions the model takes.

export const MODELS_URI = "modelgate://models";
export const INTEGRATION_URI = "modelgate://integration";
export const REQUEST_URI_TEMPLATE = "modelgate://requests/{request_id}";

function json(uri: string, value: unknown): ReadResourceResult {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

/** Resource reads surface sanitized errors as protocol errors (message only, no internals). */
async function guarded(env: ToolEnv, fn: () => Promise<ReadResourceResult>): Promise<ReadResourceResult> {
  try {
    return await fn();
  } catch (err) {
    const e = normalizeError(err, env.logger);
    // Deliberately no `cause`: only the sanitized message may reach the client.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `ModelGate error [${e.code}]: ${e.message}${e.requestId ? ` (request_id ${e.requestId})` : ""}`,
    );
  }
}

export function registerResources(server: McpServer, env: ToolEnv): void {
  server.registerResource(
    "models",
    MODELS_URI,
    {
      title: "ModelGate model catalog",
      description:
        "Models available to this ModelGate project, with provider, availability and pricing (JSON).",
      mimeType: "application/json",
    },
    async (uri, ctx) =>
      guarded(env, async () => {
        const { models } = await listModels(env.client, {}, { signal: ctx.mcpReq.signal });
        return json(uri.href, models);
      }),
  );

  server.registerResource(
    "integration",
    INTEGRATION_URI,
    {
      title: "ModelGate integration",
      description:
        "This MCP server's safe configuration (gateway URL, defaults, limits — never secrets) and the ModelGate key's project and scopes (JSON).",
      mimeType: "application/json",
    },
    async (uri, ctx) =>
      guarded(env, async () => {
        let key: unknown;
        try {
          key = (await getMe(env.client, { signal: ctx.mcpReq.signal })).me;
        } catch (err) {
          const e = normalizeError(err, env.logger);
          key = { error: e.toJSON() };
        }
        const cfg = describeConfig(env.config, env.transport);
        delete cfg.http; // listener details are operator-only
        return json(uri.href, {
          server: { name: PACKAGE_NAME, version: VERSION, transport: env.transport, config: cfg },
          modelgate_key: key,
        });
      }),
  );

  server.registerResource(
    "request",
    new ResourceTemplate(REQUEST_URI_TEMPLATE, { list: undefined }),
    {
      title: "ModelGate request record",
      description:
        "The ModelGate record (status, tokens, cost, errors, guardrail findings) for one of this project's requests.",
      mimeType: "application/json",
    },
    async (uri, variables, ctx) =>
      guarded(env, async () => {
        const raw = variables.request_id;
        const parsed = RequestIdSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
        if (!parsed.success)
          throw new ModelGateMcpError("invalid_request", "Malformed request id in resource URI.");
        const { request } = await getRequest(env.client, parsed.data, { signal: ctx.mcpReq.signal });
        return json(uri.href, request);
      }),
  );
}
