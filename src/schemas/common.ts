import * as z from "zod";

/** Providers ModelGate routes to (docs/GATEWAY.md "Supported providers"). */
export const PROVIDERS = ["OPENAI", "ANTHROPIC", "GEMINI", "AZURE_OPENAI"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ProviderSchema = z
  .enum(PROVIDERS)
  .describe(
    "Upstream provider. Omit to use the ModelGate project's primary provider. The project must have a credential for it (see modelgate_models: configured_providers).",
  );

/** Model ids as ModelGate/providers name them (e.g. gpt-4o-mini, claude-sonnet-5, gemini-2.5-flash). */
export const ModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:/@-]+$/, "model ids contain only letters, digits and . : / @ _ -")
  .describe(
    "Model id, e.g. gpt-4o-mini. Call modelgate_models to list the models available to this project.",
  );

/** Keys ModelGate attribution owns; callers cannot override them. */
export const RESERVED_METADATA_KEYS = [
  "source",
  "integration",
  "integration_version",
  "mcp_client",
  "mcp_client_version",
  "mcp_transport",
  "mcp_tool",
  "correlation_id",
] as const;

// ModelGate clamps metadata server-side (flat, ≤24 keys, key ≤64, value ≤512);
// the MCP schema is stricter so attribution keys always fit.
export const MetadataSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z][\w.-]*$/,
        "metadata keys start with a letter and contain only letters, digits, . _ -",
      ),
    z.union([z.string().max(512), z.number(), z.boolean()]),
  )
  .refine((m) => Object.keys(m).length <= 12, "at most 12 metadata keys")
  .describe(
    'Optional flat attribution tags stored with the request in ModelGate (e.g. {"workflow_id": "wf_1"}). Reserved keys (source, integration, mcp_*, correlation_id) are set by this server and ignored if supplied.',
  );

/** ModelGate request ids (x-modelgate-request-id): UUIDs today, cuid historically. */
export const RequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "a ModelGate request id (the request_id returned by modelgate_chat)")
  .describe("The ModelGate request id, as returned in request_id by modelgate_chat / modelgate_chat_stream.");
