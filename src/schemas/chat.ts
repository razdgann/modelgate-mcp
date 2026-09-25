import * as z from "zod";
import { MetadataSchema, ModelIdSchema, ProviderSchema } from "./common.js";

// Limits keep a single tool call bounded; ModelGate applies the project's own
// token limits on top (413 payload_too_large).
export const LIMITS = {
  maxMessages: 256,
  maxContentChars: 400_000,
  maxTotalChars: 1_000_000,
  maxParts: 64,
  maxTools: 64,
  maxToolCalls: 64,
  maxOutputTokens: 128_000,
} as const;

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(LIMITS.maxContentChars),
});

const ToolCallSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(64),
    arguments: z
      .string()
      .max(LIMITS.maxContentChars)
      .describe("JSON-encoded arguments, as produced by the model."),
  }),
});

export const MessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z
      .union([z.string().max(LIMITS.maxContentChars), z.array(TextPartSchema).max(LIMITS.maxParts), z.null()])
      .describe(
        "Message text (or an array of {type:'text', text} parts). null only for assistant tool-call turns.",
      ),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w-]+$/)
      .optional(),
    tool_call_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Required for role 'tool': the id of the call it answers."),
    tool_calls: z
      .array(ToolCallSchema)
      .max(LIMITS.maxToolCalls)
      .optional()
      .describe("Assistant turns only: tool calls the model made."),
  })
  .superRefine((m, ctx) => {
    if (m.role === "tool" && !m.tool_call_id) {
      ctx.addIssue({
        code: "custom",
        message: "role 'tool' messages need tool_call_id",
        path: ["tool_call_id"],
      });
    }
    if (m.content === null && !(m.role === "assistant" && m.tool_calls?.length)) {
      ctx.addIssue({
        code: "custom",
        message: "content may be null only on assistant messages with tool_calls",
        path: ["content"],
      });
    }
    if (m.tool_calls && m.role !== "assistant") {
      ctx.addIssue({
        code: "custom",
        message: "tool_calls is only valid on assistant messages",
        path: ["tool_calls"],
      });
    }
  });

const JsonSchemaObject = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 100_000, "schema is too large (max 100 KB)");

const FunctionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w-]+$/, "function names contain only letters, digits, _ and -"),
    description: z.string().max(4_000).optional(),
    parameters: JsonSchemaObject.optional().describe("JSON Schema for the function arguments."),
    strict: z.boolean().optional(),
  }),
});

const ResponseFormatSchema = z
  .union([
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("json_object") }),
    z.object({
      type: z.literal("json_schema"),
      json_schema: z.object({
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[\w-]+$/),
        description: z.string().max(4_000).optional(),
        schema: JsonSchemaObject,
        strict: z.boolean().optional(),
      }),
    }),
  ])
  .describe(
    "Output format: {type:'text'}, {type:'json_object'}, or {type:'json_schema', json_schema:{name, schema}}.",
  );

/**
 * Inputs for modelgate_chat / modelgate_chat_stream. Exactly the fields the
 * ModelGate OpenAI-compatible endpoint forwards to providers (docs/GATEWAY.md);
 * nothing is passed through unvalidated.
 */
export const ChatInputShape = {
  model: ModelIdSchema.optional().describe(
    "Model id, e.g. gpt-4o-mini. Optional only when the server has MODELGATE_DEFAULT_MODEL set. Call modelgate_models to list available models.",
  ),
  messages: z
    .array(MessageSchema)
    .min(1)
    .max(LIMITS.maxMessages)
    .describe(
      'Conversation in OpenAI chat format, oldest first, e.g. [{"role":"user","content":"Hello"}]. ModelGate forwards messages unchanged; OpenAI-format system/tool messages are fully supported by OPENAI and AZURE_OPENAI. For ANTHROPIC use user/assistant turns only.',
    ),
  provider: ProviderSchema.optional(),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Sampling temperature 0–2. ModelGate defaults to 0 (deterministic, cache-friendly)."),
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxOutputTokens)
    .optional()
    .describe("Maximum output tokens. The ModelGate project may enforce a lower limit."),
  response_format: ResponseFormatSchema.optional(),
  tools: z
    .array(FunctionToolSchema)
    .min(1)
    .max(LIMITS.maxTools)
    .optional()
    .describe("Function tools the model may call (OpenAI format). Tool calls come back in tool_calls."),
  feature: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/)
    .optional()
    .describe(
      "Optional feature name for ModelGate cost attribution (X-ModelGate-Feature), e.g. 'summarize'.",
    ),
  conversation_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w.:-]+$/)
    .optional()
    .describe("Optional stable id grouping turns of one conversation for ModelGate reliability analytics."),
  metadata: MetadataSchema.optional(),
} as const;

export const ChatInputSchema = z.object(ChatInputShape).superRefine((v, ctx) => {
  let total = 0;
  for (const m of v.messages) {
    if (typeof m.content === "string") total += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) total += p.text.length;
  }
  if (total > LIMITS.maxTotalChars) {
    ctx.addIssue({
      code: "custom",
      message: `messages exceed ${LIMITS.maxTotalChars} characters in total`,
      path: ["messages"],
    });
  }
});

export type ChatInput = z.infer<typeof ChatInputSchema>;

const UsageOut = z
  .object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() })
  .nullable();

export const ChatOutputSchema = z.object({
  request_id: z
    .string()
    .nullable()
    .describe("Canonical ModelGate request id (x-modelgate-request-id). Use with modelgate_request."),
  correlation_id: z.string().describe("Local id also stored in the request's ModelGate metadata."),
  model: z.string(),
  provider: z.string().nullable(),
  content: z.string().nullable(),
  finish_reason: z.string().nullable(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
  usage: UsageOut,
  truncated: z.boolean().describe("True when content was cut to MODELGATE_MAX_OUTPUT_CHARS."),
  streamed: z.boolean(),
  complete: z.boolean().describe("False when a stream ended early (no final usage or [DONE])."),
});

export type ChatOutput = z.infer<typeof ChatOutputSchema>;
