# Changelog

## 0.1.0 — unreleased

Initial release.

- MCP server for ModelGate over stdio and Streamable HTTP (MCP 2026-07-28, with a stateless
  fallback for 2025-era clients), built on the official MCP TypeScript SDK v2.
- Tools: `modelgate_chat`, `modelgate_chat_stream` (real gateway SSE, streamed as progress
  notifications, with upstream cancellation), `modelgate_models`, `modelgate_usage`,
  `modelgate_request`.
- Resources: `modelgate://models`, `modelgate://integration`, `modelgate://requests/{request_id}`.
- Prompts: `investigate_request`, `usage_report`, `compare_models`.
- ModelGate attribution (`source=mcp`, integration, version, MCP client, tool, correlation id),
  and propagation of the canonical `x-modelgate-request-id`.
- Stable, sanitized error codes; retries that never re-run a possibly-billed inference.
- Remote mode: passthrough or token auth, Host/Origin validation, rate limiting, body limits,
  graceful shutdown.
