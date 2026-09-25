import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { ModelGateMcpError } from "../errors/errors.js";
import type { Logger } from "../logging/logger.js";
import {
  createChatCompletion,
  parseChunk,
  streamChatCompletion,
  type ChatCompletion,
} from "../modelgate/api.js";
import { buildAttribution } from "../modelgate/attribution.js";
import { ChatInputSchema, ChatOutputSchema, type ChatInput, type ChatOutput } from "../schemas/chat.js";
import { clientIdentity, clip, newCorrelationId, runTool, type ToolEnv } from "./context.js";

export const CHAT_TOOL = "modelgate_chat";
export const CHAT_STREAM_TOOL = "modelgate_chat_stream";

const SHARED_DESCRIPTION =
  "Every call is tracked in ModelGate (tokens, cost, latency, guardrails) and returns request_id for later lookup with modelgate_request.";

/** Build the ModelGate request body + attribution headers from validated tool input. */
export function buildChatRequest(env: ToolEnv, ctx: ServerContext, tool: string, input: ChatInput) {
  const model = input.model ?? env.config.defaultModel;
  if (!model) {
    throw new ModelGateMcpError(
      "invalid_request",
      "`model` is required (no MODELGATE_DEFAULT_MODEL is configured). Call modelgate_models to list available models.",
    );
  }
  const provider = input.provider ?? env.config.defaultProvider;
  const correlationId = newCorrelationId();
  const attribution = buildAttribution({
    transport: env.transport,
    tool,
    correlationId,
    client: clientIdentity(env, ctx),
    environment: env.config.environment,
    feature: input.feature,
    conversationId: input.conversation_id,
    userMetadata: input.metadata,
  });
  const body: Record<string, unknown> = {
    model,
    messages: input.messages,
    metadata: attribution.metadata,
    ...(provider !== undefined ? { provider } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
    ...(input.response_format !== undefined ? { response_format: input.response_format } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  };
  return { body, headers: attribution.headers, correlationId, model, provider };
}

function usageOf(u: ChatCompletion["usage"]): ChatOutput["usage"] {
  if (!u) return null;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens,
  };
}

export function renderChatResult(out: ChatOutput, notes: string[] = []): CallToolResult {
  const content: CallToolResult["content"] = [];
  if (out.content) content.push({ type: "text", text: out.content });
  if (out.tool_calls?.length) {
    content.push({
      type: "text",
      text: `Tool calls requested by the model:\n${JSON.stringify(out.tool_calls, null, 2)}`,
    });
  }
  if (!out.content && !out.tool_calls?.length)
    content.push({ type: "text", text: "(the model returned no text)" });
  const usage = out.usage
    ? `${out.usage.total_tokens} tokens (${out.usage.prompt_tokens} in / ${out.usage.completion_tokens} out)`
    : "usage not reported";
  const footer = [
    `ModelGate request_id: ${out.request_id ?? "unavailable"}`,
    `model: ${out.model}${out.provider ? ` (${out.provider})` : ""}`,
    usage,
    `finish_reason: ${out.finish_reason ?? "unknown"}`,
    ...(out.truncated ? ["output truncated to MODELGATE_MAX_OUTPUT_CHARS"] : []),
    ...notes,
  ].join(" · ");
  content.push({ type: "text", text: `— ${footer}` });
  return { content, structuredContent: out };
}

function logContent(env: ToolEnv, log: Logger, fields: Record<string, unknown>) {
  if (env.config.logContent) log.debug("content (MODELGATE_LOG_CONTENT=true)", fields);
}

export function registerChatTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    CHAT_TOOL,
    {
      title: "Chat completion via ModelGate",
      description: `Run a chat completion through the ModelGate LLM gateway (OpenAI-compatible; OpenAI, Anthropic, Gemini, Azure OpenAI). Supports temperature, max_tokens, response_format (JSON mode / JSON schema) and function tools. ${SHARED_DESCRIPTION}`,
      inputSchema: ChatInputSchema,
      outputSchema: ChatOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) =>
      runTool(env, CHAT_TOOL, async (log) => {
        const req = buildChatRequest(env, ctx, CHAT_TOOL, input);
        logContent(env, log, { messages: input.messages });
        const { completion, requestId } = await createChatCompletion(env.client, req.body, {
          signal: ctx.mcpReq.signal,
          headers: req.headers,
        });
        const choice = completion.choices[0];
        const clipped = clip(choice?.message.content ?? "", env.config.maxOutputChars);
        const toolCalls = choice?.message.tool_calls;
        const out: ChatOutput = {
          request_id: requestId ?? null,
          correlation_id: req.correlationId,
          model: completion.model ?? req.model,
          provider: req.provider ?? null,
          content: choice?.message.content == null ? null : clipped.text,
          finish_reason: choice?.finish_reason ?? null,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
          usage: usageOf(completion.usage),
          truncated: clipped.truncated,
          streamed: false,
          complete: true,
        };
        logContent(env, log, { content: out.content });
        return renderChatResult(out);
      }),
  );

  server.registerTool(
    CHAT_STREAM_TOOL,
    {
      title: "Streaming chat completion via ModelGate",
      description: `Like modelgate_chat, but streams from ModelGate: text deltas are sent as MCP progress notifications while the model generates (when the client supplies a progressToken), and the tool returns the complete answer with final token usage. Cancelling the call cancels the upstream generation. Text output only — use modelgate_chat for tool calling. ${SHARED_DESCRIPTION}`,
      inputSchema: ChatInputSchema,
      outputSchema: ChatOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) =>
      runTool(env, CHAT_STREAM_TOOL, async (log) => {
        if (input.tools?.length) {
          throw new ModelGateMcpError(
            "invalid_request",
            "ModelGate streams text deltas only; tool calls are not streamed. Use modelgate_chat for requests with tools.",
          );
        }
        const req = buildChatRequest(env, ctx, CHAT_STREAM_TOOL, input);
        logContent(env, log, { messages: input.messages });
        const stream = await streamChatCompletion(env.client, req.body, {
          signal: ctx.mcpReq.signal,
          headers: req.headers,
        });
        const progress = createProgressEmitter(ctx);

        let text = "";
        let truncated = false;
        let finishReason: string | null = null;
        let usage: ChatOutput["usage"] = null;
        let model = req.model;
        let sawDone = false;
        let chunks = 0;

        for await (const data of stream.events) {
          if (data.trim() === "[DONE]") {
            sawDone = true;
            break;
          }
          const chunk = parseChunk(data, stream.requestId);
          chunks++;
          if (chunk.model) model = chunk.model;
          if (chunk.usage) usage = usageOf(chunk.usage);
          for (const choice of chunk.choices) {
            const delta = choice.delta?.content;
            if (delta) {
              if (text.length < env.config.maxOutputChars) {
                const room = env.config.maxOutputChars - text.length;
                text += delta.slice(0, room);
                if (delta.length > room) truncated = true;
              } else {
                truncated = true;
              }
              await progress.push(delta);
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
        await progress.flush();

        if (chunks === 0) {
          throw new ModelGateMcpError(
            "malformed_response",
            "The ModelGate stream ended before any data arrived.",
            {
              ...(stream.requestId ? { requestId: stream.requestId } : {}),
            },
          );
        }
        const complete = sawDone && usage !== null;
        const out: ChatOutput = {
          request_id: stream.requestId ?? null,
          correlation_id: req.correlationId,
          model,
          provider: req.provider ?? null,
          content: text,
          finish_reason: finishReason,
          usage,
          truncated,
          streamed: true,
          complete,
        };
        logContent(env, log, { content: text });
        const notes = complete
          ? [`streamed in ${chunks} chunks`]
          : [
              "WARNING: the stream ended without final usage — the upstream generation may have been interrupted; the answer may be partial. Check modelgate_request for the recorded outcome.",
            ];
        return renderChatResult(out, notes);
      }),
  );
}

/**
 * Forwards stream deltas as `notifications/progress` (MCP's mechanism for
 * incremental updates during a tool call). Deltas are coalesced (≥ 64 chars or
 * 150 ms) so a fast stream does not flood the client, and each notification's
 * `progress` strictly increases as the spec requires. No-op when the client
 * did not ask for progress.
 */
function createProgressEmitter(ctx: ServerContext) {
  const token = ctx.mcpReq._meta?.progressToken;
  let pending = "";
  let last = Date.now();
  let seq = 0;
  let received = 0;
  const send = async () => {
    if (token === undefined || pending === "") return;
    const message = pending.length > 4_000 ? `${pending.slice(0, 4_000)}…` : pending;
    pending = "";
    last = Date.now();
    seq++;
    try {
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken: token, progress: seq, message },
      });
    } catch {
      // A client that stopped listening must not fail the generation.
    }
  };
  return {
    async push(delta: string) {
      received += delta.length;
      if (token === undefined) return;
      pending += delta;
      if (pending.length >= 64 || Date.now() - last >= 150) await send();
    },
    async flush() {
      await send();
    },
    get received() {
      return received;
    },
  };
}
