# Architecture

`modelgate-mcp` is a thin adapter between the Model Context Protocol and the ModelGate API. It
turns MCP tool calls, resource reads and prompts into ModelGate HTTP calls, and turns the
responses back into MCP results.

```
MCP client ──(stdio | Streamable HTTP)──► transports/ ──► server.ts (factory)
                                                          │  one McpServer per connection/request,
                                                          │  bound to exactly one ModelGate key
                                                          ▼
                                   tools/ · resources/ · prompts/   (schemas/, errors/)
                                                          ▼
                                   modelgate/api.ts ──► modelgate/client.ts ──HTTPS──► ModelGate
```

## Layers

| Directory                                      | Responsibility                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/transports/`                              | `stdio.ts` (`serveStdio`) and `http.ts` (`createMcpHandler` + `toNodeHandler`, with auth, Host/Origin checks, rate limits and shutdown). These modules know nothing about ModelGate. |
| `src/server.ts`                                | Factory that builds an `McpServer`, resolves the credential for this connection or request, and registers the surface.                                                               |
| `src/tools/`, `src/resources/`, `src/prompts/` | The MCP surface: validated inputs, result formatting, structured output                                                                                                              |
| `src/schemas/`                                 | Zod schemas for tool inputs and outputs. Bounded, with descriptions written for the calling model.                                                                                   |
| `src/modelgate/`                               | HTTP client (auth header, timeouts, cancellation, bounded bodies, retries, no redirects), SSE parser, attribution, and typed API wrappers with lenient response validation           |
| `src/errors/`                                  | Stable error codes, mapping from ModelGate's documented error bodies, and tool error results                                                                                         |
| `src/security/`                                | Base-URL validation, remote auth, rate limiter                                                                                                                                       |
| `src/logging/`                                 | JSON-lines logger (stderr) and redaction                                                                                                                                             |
| `src/config/`                                  | Environment and programmatic config, validated at startup                                                                                                                            |

## What stays in ModelGate

This package deliberately does **not** implement provider integrations, routing or failover, cost
calculation, usage storage, caching, guardrails or prompt-injection detection, tenant management,
billing, or key authority. Each of these is a ModelGate API call, and the MCP layer only forwards
and presents the result. Example: `modelgate_usage` returns the aggregates computed by
`GET /v1/usage`. It never sums anything itself.

## ModelGate API used

| MCP                                                  | ModelGate endpoint                                |
| ---------------------------------------------------- | ------------------------------------------------- |
| `modelgate_chat`                                     | `POST /v1/chat/completions` (`stream: false`)     |
| `modelgate_chat_stream`                              | `POST /v1/chat/completions` (`stream: true`, SSE) |
| `modelgate_models`, `modelgate://models`             | `GET /v1/models`                                  |
| `modelgate_usage`                                    | `GET /v1/usage`                                   |
| `modelgate_request`, `modelgate://requests/{id}`     | `GET /v1/requests/:id`                            |
| `modelgate://integration`, remote key check, `check` | `GET /v1/me`                                      |

The four `GET` endpoints and key scopes are the ModelGate integration API, added to ModelGate
specifically so this adapter needs no backend of its own. See ModelGate `docs/GATEWAY.md`.

## Protocol decisions

- **SDK:** official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and
  `@modelcontextprotocol/node`), which implements MCP 2026-07-28. It also serves 2025-era clients
  through the SDK's negotiation over stdio, and its stateless fallback over HTTP. No deprecated
  transports (HTTP+SSE) are used.
- **Stateless HTTP:** one server instance per HTTP request (the SDK's recommended model). It scales
  horizontally, and no session holds a credential.
- **Streaming:** MCP tool results are not streamable, so deltas are sent as
  `notifications/progress` messages during the call, and the tool returns the complete result.
  This uses the gateway's real SSE stream; nothing is buffered to fake streaming.
- **Tool errors** are returned as `isError` results, not protocol errors, so the calling model can
  read them and adapt.

## Attribution and tracing

Every inference call sends ModelGate's own attribution headers (`X-ModelGate-Source: mcp`,
`X-ModelGate-Integration: modelgate-mcp`, optional environment, feature and conversation id). It
also sends a `metadata` bag containing `integration_version`, `mcp_client`, `mcp_client_version`,
`mcp_transport`, `mcp_tool` and `correlation_id`. Headers take precedence over body metadata
inside ModelGate, and the reserved keys are stripped from user metadata, so callers cannot spoof
`source`.

The canonical id is ModelGate's `x-modelgate-request-id`, returned as `request_id`. The local
`correlation_id` is additional; it never replaces the canonical id.

Client identity comes from the per-request envelope on 2026-07-28 connections, or from the
`initialize` handshake on 2025-era stdio connections. Stateless HTTP serving of 2025-era clients
has no handshake context at tool-call time, so `mcp_client` is omitted there.
