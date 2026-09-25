import * as z from "zod";
import { ModelGateMcpError } from "../errors/errors.js";
import type { CallOptions, ModelGateClient } from "./client.js";

// Thin typed wrappers over the ModelGate API (docs/GATEWAY.md, docs/openapi.yaml
// in the ModelGate repo). Responses are validated leniently — unknown fields
// are ignored — but a response missing what we rely on is reported as
// malformed_response instead of being passed on half-parsed.

const ToolCall = z.object({
  id: z.string(),
  type: z.string().default("function"),
  function: z.object({ name: z.string(), arguments: z.string().default("") }),
});

const Usage = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative().optional(),
});

export const ChatCompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCall).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: Usage.nullable().optional(),
});
export type ChatCompletion = z.infer<typeof ChatCompletionSchema>;

export const ChatChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({ role: z.string().optional(), content: z.string().nullable().optional() })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: Usage.nullable().optional(),
});
export type ChatChunk = z.infer<typeof ChatChunkSchema>;

export const ModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      provider: z.string().optional(),
      owned_by: z.string().optional(),
      available: z.boolean().optional(),
      pricing: z
        .object({
          currency: z.string().optional(),
          input_per_1m_tokens: z.string().optional(),
          output_per_1m_tokens: z.string().optional(),
        })
        .optional(),
    }),
  ),
  default_provider: z.string().nullable().optional(),
  configured_providers: z.array(z.string()).optional(),
});
export type ModelList = z.infer<typeof ModelsSchema>;

const UsageTotals = z.object({
  requests: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  cost_usd: z.string(),
  saved_usd: z.string().optional(),
  errors: z.number().optional(),
  cache_hits: z.number().optional(),
});

export const UsageSchema = z.object({
  object: z.literal("usage"),
  from: z.string(),
  to: z.string(),
  filters: z.record(z.string(), z.string().nullable()).optional(),
  totals: UsageTotals,
  group_by: z.string().optional(),
  groups: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type UsageReport = z.infer<typeof UsageSchema>;

export const RequestRecordSchema = z
  .object({ object: z.literal("request"), id: z.string(), status: z.string() })
  .catchall(z.unknown());
export type RequestRecord = z.infer<typeof RequestRecordSchema>;

export const MeSchema = z.object({
  object: z.literal("api_key"),
  key: z.object({ id: z.string(), name: z.string().nullable().optional() }),
  project: z.object({ id: z.string(), name: z.string().nullable().optional() }),
  scopes: z.array(z.string()),
  legacy_full_access: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string, requestId: string | undefined): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new ModelGateMcpError("malformed_response", `ModelGate returned an unexpected ${what} response.`, {
    ...(requestId ? { requestId } : {}),
  });
}

export async function createChatCompletion(
  client: ModelGateClient,
  body: Record<string, unknown>,
  options: CallOptions,
) {
  const res = await client.postJson("/v1/chat/completions", { ...body, stream: false }, options);
  return {
    completion: parse(ChatCompletionSchema, res.data, "chat completion", res.requestId),
    requestId: res.requestId,
  };
}

export async function streamChatCompletion(
  client: ModelGateClient,
  body: Record<string, unknown>,
  options: CallOptions,
) {
  return client.postStream("/v1/chat/completions", { ...body, stream: true }, options);
}

export function parseChunk(data: string, requestId: string | undefined): ChatChunk {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ModelGateMcpError(
      "malformed_response",
      "ModelGate sent a stream chunk that is not valid JSON.",
      {
        ...(requestId ? { requestId } : {}),
      },
    );
  }
  return parse(ChatChunkSchema, json, "stream chunk", requestId);
}

export async function listModels(
  client: ModelGateClient,
  query: { provider?: string | undefined; available?: boolean | undefined },
  options: CallOptions,
) {
  const res = await client.getJson(
    "/v1/models",
    {
      provider: query.provider,
      available: query.available === undefined ? undefined : String(query.available),
    },
    options,
  );
  return { models: parse(ModelsSchema, res.data, "model list", res.requestId), requestId: res.requestId };
}

export async function getUsage(
  client: ModelGateClient,
  query: Record<string, string | undefined>,
  options: CallOptions,
) {
  const res = await client.getJson("/v1/usage", query, options);
  return { usage: parse(UsageSchema, res.data, "usage", res.requestId), requestId: res.requestId };
}

export async function getRequest(client: ModelGateClient, id: string, options: CallOptions) {
  const res = await client.getJson(`/v1/requests/${encodeURIComponent(id)}`, {}, options);
  return {
    request: parse(RequestRecordSchema, res.data, "request", res.requestId),
    requestId: res.requestId,
  };
}

export async function getMe(client: ModelGateClient, options: CallOptions) {
  const res = await client.getJson("/v1/me", {}, options);
  return { me: parse(MeSchema, res.data, "key identity", res.requestId), requestId: res.requestId };
}
