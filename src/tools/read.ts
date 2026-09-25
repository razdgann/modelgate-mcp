import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ModelGateMcpError } from "../errors/errors.js";
import { getRequest, getUsage, listModels } from "../modelgate/api.js";
import { ModelIdSchema, ProviderSchema, RequestIdSchema } from "../schemas/common.js";
import { runTool, type ToolEnv } from "./context.js";

export const MODELS_TOOL = "modelgate_models";
export const USAGE_TOOL = "modelgate_usage";
export const REQUEST_TOOL = "modelgate_request";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const PERIOD_MS = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
} as const;

const ModelsOutput = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      provider: z.string().nullable(),
      available: z.boolean().nullable(),
      input_per_1m_tokens_usd: z.string().nullable(),
      output_per_1m_tokens_usd: z.string().nullable(),
    }),
  ),
  count: z.number(),
  default_provider: z.string().nullable(),
  configured_providers: z.array(z.string()),
});

const UsageOutput = z.object({
  from: z.string(),
  to: z.string(),
  filters: z.record(z.string(), z.string().nullable()),
  totals: z.record(z.string(), z.union([z.number(), z.string()])),
  group_by: z.string().nullable(),
  groups: z.array(z.record(z.string(), z.unknown())),
});

/** Render an untyped record field for human-readable text. */
function show(v: unknown, fallback = "?"): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function registerReadTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    MODELS_TOOL,
    {
      title: "List ModelGate models",
      description:
        "List the models available through ModelGate for this project, with provider, availability (whether the project has that provider's credential) and price per 1M tokens. Use it to choose a `model` for modelgate_chat.",
      inputSchema: z.object({
        provider: ProviderSchema.optional().describe("Only models from this provider."),
        available_only: z
          .boolean()
          .optional()
          .describe("Only models whose provider is configured for this project (default false)."),
      }),
      outputSchema: ModelsOutput,
      annotations: READ_ONLY,
    },
    async (input, ctx) =>
      runTool(env, MODELS_TOOL, async () => {
        const { models } = await listModels(
          env.client,
          { provider: input.provider, available: input.available_only === true ? true : undefined },
          { signal: ctx.mcpReq.signal },
        );
        const out = {
          models: models.data.map((m) => ({
            id: m.id,
            provider: m.provider ?? m.owned_by?.toUpperCase() ?? null,
            available: m.available ?? null,
            input_per_1m_tokens_usd: m.pricing?.input_per_1m_tokens ?? null,
            output_per_1m_tokens_usd: m.pricing?.output_per_1m_tokens ?? null,
          })),
          count: models.data.length,
          default_provider: models.default_provider ?? null,
          configured_providers: models.configured_providers ?? [],
        };
        const lines = out.models.map(
          (m) =>
            `- ${m.id} (${m.provider ?? "?"})${m.available === false ? " — provider not configured" : ""}` +
            (m.input_per_1m_tokens_usd
              ? ` · $${m.input_per_1m_tokens_usd} in / $${m.output_per_1m_tokens_usd ?? "?"} out per 1M tokens`
              : ""),
        );
        const header = `${out.count} model(s). Default provider: ${out.default_provider ?? "none"}. Configured providers: ${out.configured_providers.join(", ") || "none"}.`;
        return { content: [{ type: "text", text: [header, ...lines].join("\n") }], structuredContent: out };
      }),
  );

  server.registerTool(
    USAGE_TOOL,
    {
      title: "ModelGate usage and cost",
      description:
        "Aggregate ModelGate usage for this project over a time window: requests, errors, cache hits, input/output tokens and cost in USD, optionally grouped by model, source (integration), provider or day. Use period for a relative window or from/to for an exact one (default: last 30 days).",
      inputSchema: z
        .object({
          period: z.enum(["24h", "7d", "30d", "90d"]).optional().describe("Relative window ending now."),
          from: z.iso
            .datetime({ offset: true })
            .optional()
            .describe("Window start, ISO-8601 (e.g. 2026-09-01T00:00:00Z)."),
          to: z.iso.datetime({ offset: true }).optional().describe("Window end, ISO-8601. Default now."),
          model: ModelIdSchema.optional().describe("Only this model."),
          source: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[\w.-]+$/)
            .optional()
            .describe("Only this attribution source, e.g. 'mcp' (this server), 'n8n', 'sdk'."),
          provider: ProviderSchema.optional().describe("Only this provider."),
          group_by: z.enum(["model", "source", "provider", "day"]).optional(),
        })
        .refine((v) => !(v.period && (v.from || v.to)), "use either period or from/to, not both"),
      outputSchema: UsageOutput,
      annotations: READ_ONLY,
    },
    async (input, ctx) =>
      runTool(env, USAGE_TOOL, async () => {
        const now = Date.now();
        const from = input.period ? new Date(now - PERIOD_MS[input.period]).toISOString() : input.from;
        const to = input.period ? new Date(now).toISOString() : input.to;
        if (from && to && Date.parse(from) >= Date.parse(to)) {
          throw new ModelGateMcpError("invalid_request", "`from` must be earlier than `to`.");
        }
        const { usage } = await getUsage(
          env.client,
          {
            from,
            to,
            model: input.model,
            source: input.source,
            provider: input.provider,
            group_by: input.group_by,
          },
          { signal: ctx.mcpReq.signal },
        );
        const t = usage.totals;
        const out = {
          from: usage.from,
          to: usage.to,
          filters: usage.filters ?? {},
          totals: t,
          group_by: usage.group_by ?? null,
          groups: usage.groups ?? [],
        };
        const lines = [
          `ModelGate usage ${usage.from} → ${usage.to}`,
          `requests: ${t.requests}${t.errors !== undefined ? ` (errors: ${t.errors})` : ""}${t.cache_hits !== undefined ? ` · cache hits: ${t.cache_hits}` : ""}`,
          `tokens: ${t.total_tokens} (${t.input_tokens} in / ${t.output_tokens} out)`,
          `cost: $${t.cost_usd}${t.saved_usd !== undefined ? ` · saved: $${t.saved_usd}` : ""}`,
        ];
        if (out.group_by) {
          lines.push(`by ${out.group_by}:`);
          for (const g of out.groups) {
            const key = show(g[out.group_by], "(none)");
            lines.push(
              `- ${key}: ${show(g.requests)} req · ${show(g.total_tokens)} tokens · $${show(g.cost_usd)}`,
            );
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: out };
      }),
  );

  server.registerTool(
    REQUEST_TOOL,
    {
      title: "Look up a ModelGate request",
      description:
        "Fetch the ModelGate record for one of this project's requests by request_id (as returned by modelgate_chat): status, provider, model, tokens, cost, latency, cache hit, error code, attribution, and any guardrail or reliability findings. Useful for debugging a failed or surprising call. Prompts and responses are not returned.",
      inputSchema: z.object({ request_id: RequestIdSchema }),
      annotations: READ_ONLY,
    },
    async (input, ctx) =>
      runTool(env, REQUEST_TOOL, async () => {
        const { request } = await getRequest(env.client, input.request_id, { signal: ctx.mcpReq.signal });
        const r = request as Record<string, unknown>;
        const usage = (r.usage ?? {}) as Record<string, unknown>;
        const err = r.error as { code?: unknown; message?: unknown } | null | undefined;
        const guards = Array.isArray(r.guard_events) ? r.guard_events.length : 0;
        const rel = Array.isArray(r.reliability_incidents) ? r.reliability_incidents.length : 0;
        const lines = [
          `ModelGate request ${show(r.id)} — status ${show(r.status)}`,
          `time: ${show(r.timestamp, "?")} · source: ${show(r.source, "none")}`,
          `provider/model: ${show(r.provider, "?")} / ${show(r.model, "?")}`,
          `tokens: ${show(usage.total_tokens, "?")} (${show(usage.input_tokens, "?")} in / ${show(usage.output_tokens, "?")} out) · cost: $${show(r.cost_usd, "?")} · latency: ${show(r.latency_ms, "?")} ms · cache hit: ${show(r.cache_hit, "?")}`,
          ...(err ? [`error: ${show(err.code)}${err.message ? ` — ${show(err.message)}` : ""}`] : []),
          `guardrail events: ${guards} · reliability incidents: ${rel}`,
        ];
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: JSON.stringify(request, null, 2) },
          ],
          structuredContent: { ...request, request_id: show(r.id) },
        };
      }),
  );
}
