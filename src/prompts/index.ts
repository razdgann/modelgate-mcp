import type { GetPromptResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { RequestIdSchema } from "../schemas/common.js";

// A few workflows grounded in what ModelGate actually records. Each prompt
// tells the model which modelgate_* tools to call and how to read ModelGate's
// fields; none of them is a generic AI prompt.

function user(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "investigate_request",
    {
      title: "Investigate a ModelGate request",
      description: "Diagnose one ModelGate request (failed, slow, expensive or blocked) from its request id.",
      argsSchema: z.object({ request_id: RequestIdSchema }),
    },
    ({ request_id }) =>
      user(
        [
          `Investigate ModelGate request ${request_id}.`,
          "1. Call modelgate_request with this request_id.",
          "2. Explain the outcome from its fields: status (OK, BAD_REQUEST, AUTH_ERROR, LIMIT_ERROR, GUARD_BLOCKED, CANCELLED, ERROR), error.code (e.g. PROVIDER_ERROR, PROVIDER_NOT_CONFIGURED, RATE_LIMIT, MONTHLY_QUOTA, MAX_PROMPT_TOKENS, PROMPT_INJECTION_BLOCKED, STREAM_INTERRUPTED, PRICE_MISSING), guard_events, reliability_incidents and waste flags.",
          "3. Report provider, model, tokens, cost_usd and latency_ms, and whether it was a cache hit.",
          "4. Give the most likely cause and a concrete fix (request change, model change, or the ModelGate dashboard setting to adjust). Say plainly when the record does not explain the failure.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "usage_report",
    {
      title: "ModelGate usage and cost report",
      description:
        "Summarize ModelGate spend and token usage for a period and point out the main cost drivers.",
      argsSchema: z.object({
        period: z.enum(["24h", "7d", "30d", "90d"]).optional().describe("Window to report on (default 30d)."),
      }),
    },
    ({ period }) => {
      const p = period ?? "30d";
      return user(
        [
          `Produce a ModelGate usage report for the last ${p}.`,
          `1. Call modelgate_usage with period "${p}" for totals, then again with group_by "model" and with group_by "source".`,
          "2. Report total requests, errors, cache hits, input/output tokens, cost_usd and saved_usd.",
          "3. Rank models and sources by cost; call out the biggest cost driver, the error rate, and any source (integration) with unusual volume.",
          "4. If a costly model has a cheaper model from the same provider in modelgate_models, mention it as an option to evaluate — do not claim quality parity.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "compare_models",
    {
      title: "Compare models through ModelGate",
      description:
        "Run the same prompt on several models via ModelGate and compare answers, tokens, cost and latency.",
      argsSchema: z.object({
        models: z
          .string()
          .min(1)
          .max(500)
          .describe("Comma-separated model ids, e.g. gpt-4o-mini,gpt-4.1-mini"),
        prompt: z.string().min(1).max(20_000).describe("The user prompt to send to every model."),
      }),
    },
    ({ models, prompt }) => {
      const list = models
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
        .slice(0, 5);
      return user(
        [
          `Compare these models through ModelGate: ${list.join(", ")}.`,
          "1. Call modelgate_models to confirm each model is available; skip (and report) any that are not.",
          "2. For each available model call modelgate_chat with temperature 0 and this single user message:",
          "<prompt>",
          prompt,
          "</prompt>",
          "3. For each result call modelgate_request with its request_id to get cost_usd and latency_ms.",
          "4. Present a table (model, tokens in/out, cost_usd, latency_ms) and a short qualitative comparison of the answers.",
        ].join("\n"),
      );
    },
  );
}
