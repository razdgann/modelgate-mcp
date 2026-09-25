# Tool reference

Every tool validates its input against a bounded schema before calling ModelGate. Invalid input
returns an `isError` result and makes no network call. Every inference result carries
`request_id`, the canonical ModelGate id.

## `modelgate_chat`

A non-streaming chat completion through `POST /v1/chat/completions`.

| Input             | Type             | Notes                                                                                                                                                                             |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | string           | e.g. `gpt-4o-mini`. Optional only when `MODELGATE_DEFAULT_MODEL` is set.                                                                                                          |
| `messages`        | array (1–256)    | `{role: system\|user\|assistant\|tool, content: string \| [{type:"text",text}] \| null, name?, tool_call_id?, tool_calls?}`. At most 400k characters per message and 1M in total. |
| `provider`        | enum             | `OPENAI`, `ANTHROPIC`, `GEMINI` or `AZURE_OPENAI`. Defaults to `MODELGATE_DEFAULT_PROVIDER`, then the project's primary provider.                                                 |
| `temperature`     | number 0–2       | ModelGate's default is 0                                                                                                                                                          |
| `max_tokens`      | integer 1–128000 | The project may enforce a lower limit (`payload_too_large`)                                                                                                                       |
| `response_format` | object           | `{type:"text"}`, `{type:"json_object"}`, or `{type:"json_schema", json_schema:{name, schema, strict?}}`                                                                           |
| `tools`           | array (1–64)     | OpenAI function tools `{type:"function", function:{name, description?, parameters?}}`                                                                                             |
| `feature`         | string           | Cost attribution, sent as `X-ModelGate-Feature`                                                                                                                                   |
| `conversation_id` | string           | Groups turns for ModelGate reliability analytics                                                                                                                                  |
| `metadata`        | object           | Flat attribution tags (at most 12 keys; values are strings of up to 512 characters, numbers or booleans). Reserved keys are ignored.                                              |

Structured output: `{request_id, correlation_id, model, provider, content, finish_reason,
tool_calls?, usage{prompt_tokens, completion_tokens, total_tokens}|null, truncated, streamed,
complete}`.

Not accepted, because the gateway does not forward them to providers today: `top_p`, `stop`,
`tool_choice`, `max_completion_tokens`, and image or audio content parts.

**Provider message formats.** ModelGate forwards `messages` unchanged. The OpenAI format,
including `system` and `tool` messages, is fully supported for `OPENAI` and `AZURE_OPENAI`. For
`ANTHROPIC`, use user/assistant turns with string content. Gemini's native `contents` shape cannot
be expressed through this tool.

## `modelgate_chat_stream`

Same inputs, except `tools`: ModelGate streams text only, so a request with `tools` is rejected
with `invalid_request`. The call streams from the gateway and forwards deltas as
`notifications/progress` when the client supplies a `progressToken`. It returns the same
structured output with `streamed: true`, and `complete: false` if the stream ended without final
usage. Cancelling the call aborts the upstream generation.

## `modelgate_models`

| Input            | Type    | Notes                                                       |
| ---------------- | ------- | ----------------------------------------------------------- |
| `provider`       | enum    | Optional filter                                             |
| `available_only` | boolean | Only models whose provider has a credential in this project |

Output: `{models:[{id, provider, available, input_per_1m_tokens_usd, output_per_1m_tokens_usd}],
count, default_provider, configured_providers}`. The list comes from ModelGate's price catalog and
the project's credentials; nothing is hard-coded.

## `modelgate_usage`

| Input                         | Type                                   | Notes                                                                             |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `period`                      | `24h`, `7d`, `30d` or `90d`            | Relative window. Do not combine with `from`/`to`.                                 |
| `from`, `to`                  | ISO-8601                               | Exact window. The default is the last 30 days; ModelGate allows at most 366 days. |
| `model`, `source`, `provider` | string or enum                         | Filters. `source: "mcp"` selects this integration's traffic.                      |
| `group_by`                    | `model`, `source`, `provider` or `day` | Up to 100 groups                                                                  |

Output: `{from, to, filters, totals{requests, errors, cache_hits, input_tokens, output_tokens,
total_tokens, cost_usd, saved_usd}, group_by, groups[]}`.

## `modelgate_request`

| Input        | Type                    |
| ------------ | ----------------------- |
| `request_id` | `^[A-Za-z0-9_-]{8,64}$` |

Output: the ModelGate record. Fields: `status`, `provider`, `model`, `feature`, `source`,
`metadata`, `usage`, `cost_usd`, `saved_usd`, `latency_ms`, `cache_hit`, `error{code, message}`,
`waste`, `reliability_flags`, `guard_events[]`, `reliability_incidents[]`. Prompts and responses
are never included. Another project's id returns `not_found`.

Status values: `OK`, `BAD_REQUEST`, `AUTH_ERROR`, `LIMIT_ERROR`, `GUARD_BLOCKED`, `CANCELLED`,
`ERROR`.

## Error codes

| Code                                | Retryable | Typical cause                                                                    |
| ----------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `auth_invalid`                      | no        | Missing, invalid or revoked key                                                  |
| `insufficient_scope`                | no        | The key lacks `details.required_scope`                                           |
| `invalid_request`                   | no        | Schema or window validation failed, or the gateway rejected the body             |
| `invalid_model`                     | no        | The provider returned 404 for the model                                          |
| `provider_required`                 | no        | No `provider` given and no primary provider set                                  |
| `provider_not_configured`           | no        | No project credential for that provider                                          |
| `rate_limited`                      | yes       | ModelGate per-key rate limit (`retry_after_seconds`)                             |
| `quota_exceeded`                    | no        | Monthly spend cap reached                                                        |
| `payload_too_large`                 | no        | Project prompt or output token limit                                             |
| `guardrail_blocked`                 | no        | Prompt-injection guardrail in ENFORCE mode                                       |
| `stream_unavailable`                | no        | Streaming refused because of ENFORCE redaction                                   |
| `provider_error`                    | depends   | The provider failed (`details.provider_status`)                                  |
| `provider_timeout`                  | yes       | The provider timed out                                                           |
| `gateway_error` / `gateway_timeout` | yes       | ModelGate 5xx, or `MODELGATE_TIMEOUT_MS` exceeded                                |
| `network_error`                     | usually   | Could not reach ModelGate, a redirect was refused, or the stream was interrupted |
| `cancelled`                         | no        | The client cancelled the call                                                    |
| `malformed_response`                | no        | Unexpected upstream payload                                                      |
| `not_found`                         | no        | No such request in this project                                                  |
| `endpoint_unavailable`              | no        | The gateway lacks the integration API                                            |
| `internal_error`                    | no        | Bug in this server (details are logged, not returned)                            |
