# ModelGate MCP

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[ModelGate](https://modelgatehq.com). It lets Claude, Cursor, VS Code and any other MCP client run LLM
calls through the ModelGate gateway, and look up models, usage, cost and request traces.

```
MCP client (Claude, Cursor, VS Code, agents)
   │  MCP: stdio or Streamable HTTP
   ▼
modelgate-mcp  ── thin adapter: schemas, auth, attribution, errors
   │  HTTPS: /v1/chat/completions, /v1/models, /v1/usage, /v1/requests/:id
   ▼
ModelGate gateway  ── keys and scopes, guardrails, routing, cache, cost, tracing
   │
   ▼
OpenAI · Anthropic · Gemini · Azure OpenAI
```

The package is only an adapter. Routing, provider access, guardrails, cost calculation, usage
storage and key authority all stay in ModelGate (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## Contents

1. [Why use ModelGate through MCP](#why-use-modelgate-through-mcp)
2. [Requirements](#requirements)
3. [API key setup](#api-key-setup)
4. [Quick start](#quick-start)
5. [Claude configuration](#claude-configuration) · [Cursor](#cursor) · [VS Code and other clients](#vs-code-and-other-clients)
6. [Tools](#tools) · [Resources](#resources) · [Prompts](#prompts) · [Streaming](#streaming)
7. [Authentication and scopes](#authentication-and-scopes)
8. [Configuration reference](#configuration-reference)
9. [Errors](#errors) · [Security](#security)
10. [Development](#development) · [Testing](#testing) · [Publishing](#publishing)
11. [Troubleshooting](#troubleshooting)

## Why use ModelGate through MCP

- **One gateway for every model.** Call OpenAI, Anthropic, Gemini and Azure OpenAI models from any
  MCP client, using the provider credentials stored in your ModelGate project.
- **Every call is observed.** Tokens, cost, latency, cache hits, and guardrail and reliability
  findings are recorded, and each call is tagged `source=mcp` so MCP traffic shows up as its own
  source in ModelGate.
- **Traceable.** Every result carries the canonical ModelGate `request_id`. Agents can pass it to
  `modelgate_request` to debug their own calls.
- **Scoped keys.** Give MCP clients an integration key that can run inference and read usage, but
  cannot manage keys, provider credentials or settings.

## Requirements

- Node.js **22.12 or newer** (`node --version`).
- A ModelGate account and an API key (`mg_…`).
- An MCP client. Any client that supports stdio or Streamable HTTP works.

> **Gateway version.** `modelgate_chat` and `modelgate_chat_stream` work with every ModelGate
> deployment. `modelgate_models`, `modelgate_usage`, `modelgate_request`, the resources, and
> integration-scoped keys need the ModelGate **integration API** (`/v1/me`, `/v1/models`,
> `/v1/usage`, `/v1/requests/:id`). On a gateway without it, those tools return
> `endpoint_unavailable` and do nothing else.

## API key setup

1. Sign in at [modelgatehq.com](https://modelgatehq.com) and open **Dashboard → Provider
   credentials**. Add a key for at least one provider (for example OpenAI) and choose a
   **primary provider** under **Settings**.
2. Open **Dashboard → API keys**. Pick **Integration (MCP / agents)** as the access level and
   click **Create key**. Copy the `mg_…` key, which is shown only once. If your dashboard has no
   access selector yet, the gateway predates key scopes: create a regular key. It works, but it is
   a full-access key, so keep it private.
3. Check it:

   ```bash
   MODELGATE_KEY=YOUR_MODELGATE_KEY npx -y modelgate-mcp check
   ```

   You should see `configuration: OK`, `reachable`, and `API key: valid — project "…"`.

## Quick start

Add the server to your client (see below for other clients):

```bash
claude mcp add --env MODELGATE_KEY=YOUR_MODELGATE_KEY --transport stdio modelgate -- npx -y modelgate-mcp
```

Then ask:

> Use ModelGate to list the available models, then ask gpt-4o-mini for a one-line haiku and tell
> me the request id and token usage.

The client calls `modelgate_models`, then `modelgate_chat`. The request appears in the ModelGate
dashboard under **Requests** with source `mcp`.

## Claude configuration

### Claude Code

Local (stdio). This is recommended:

```bash
claude mcp add --env MODELGATE_KEY=YOUR_MODELGATE_KEY --transport stdio modelgate -- npx -y modelgate-mcp
```

Add `--scope user` to make it available in every project. To share it with a team, use a
project-scoped `.mcp.json` that reads the key from each developer's environment:

```json
{
  "mcpServers": {
    "modelgate": {
      "command": "npx",
      "args": ["-y", "modelgate-mcp"],
      "env": { "MODELGATE_KEY": "${MODELGATE_KEY}" }
    }
  }
}
```

Remote (a [self-hosted HTTP server](#remote-server)):

```bash
claude mcp add --transport http modelgate https://mcp.example.com/mcp --header "Authorization: Bearer YOUR_MODELGATE_KEY"
```

### Claude Desktop

Open **Settings → Developer → Edit Config** and add the server to `claude_desktop_config.json`.
The file is at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "modelgate": {
      "command": "npx",
      "args": ["-y", "modelgate-mcp"],
      "env": { "MODELGATE_KEY": "YOUR_MODELGATE_KEY" }
    }
  }
}
```

Fully quit and restart Claude Desktop. Claude Desktop's remote custom connectors authenticate with
OAuth, which ModelGate does not provide, so use the local configuration above.

## Cursor

Put this in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

Local:

```json
{
  "mcpServers": {
    "modelgate": {
      "command": "npx",
      "args": ["-y", "modelgate-mcp"],
      "env": { "MODELGATE_KEY": "${env:MODELGATE_KEY}" }
    }
  }
}
```

Remote:

```json
{
  "mcpServers": {
    "modelgate": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:MODELGATE_KEY}" }
    }
  }
}
```

## VS Code and other clients

VS Code (`.vscode/mcp.json`). The key is prompted for once and then stored securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "modelgate-key", "description": "ModelGate API key", "password": true }
  ],
  "servers": {
    "modelgate": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "modelgate-mcp"],
      "env": { "MODELGATE_KEY": "${input:modelgate-key}" }
    }
  }
}
```

For remote, use `"type": "http"`, `"url": "https://mcp.example.com/mcp"` and
`"headers": { "Authorization": "Bearer ${input:modelgate-key}" }`.

Any other MCP host can launch `npx -y modelgate-mcp` with `MODELGATE_KEY` in its environment, or
connect to a remote server over Streamable HTTP with an `Authorization: Bearer` header. More
examples are in [`examples/`](examples).

## Tools

| Tool                    | What it does                                                                                                                                                                                                                                                                                        | Scope needed      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `modelgate_chat`        | Chat completion through ModelGate. Supports `model`, `messages`, `provider`, `temperature`, `max_tokens`, `response_format` (JSON mode or JSON schema), function `tools`, and attribution (`feature`, `conversation_id`, `metadata`). Returns the answer, tool calls, token usage and `request_id`. | `inference:write` |
| `modelgate_chat_stream` | The same call, streamed: text deltas arrive as progress notifications and the final result includes usage. Cancelling the call cancels the generation.                                                                                                                                              | `inference:write` |
| `modelgate_models`      | Models available to your project, with provider, availability and price per 1M tokens.                                                                                                                                                                                                              | `models:read`     |
| `modelgate_usage`       | Requests, errors, cache hits, tokens and cost over a period, optionally grouped by `model`, `source`, `provider` or `day`.                                                                                                                                                                          | `usage:read`      |
| `modelgate_request`     | The ModelGate record for one of your requests: status, tokens, cost, latency, error code, and guardrail or reliability findings. Prompts and responses are never returned.                                                                                                                          | `requests:read`   |

Every input has an explicit, bounded schema. Parameters the gateway does not forward to providers
(`top_p`, `stop`, `tool_choice`, images) are not accepted, rather than silently dropped. Full
reference: [docs/TOOLS.md](docs/TOOLS.md).

## Resources

| URI                                 | Content                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `modelgate://models`                | Model catalog (JSON)                                                                            |
| `modelgate://integration`           | This server's safe configuration, plus the key's project and scopes. It never contains secrets. |
| `modelgate://requests/{request_id}` | One request record (JSON)                                                                       |

## Prompts

| Prompt                | Arguments                      | Purpose                                                                         |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `investigate_request` | `request_id`                   | Diagnose a failed, slow, expensive or blocked request from its ModelGate record |
| `usage_report`        | `period` (24h, 7d, 30d or 90d) | Spend and token report with the main cost drivers                               |
| `compare_models`      | `models`, `prompt`             | Run one prompt on several models and compare the answers, cost and latency      |

## Streaming

MCP tool results cannot be streamed, so incremental output uses MCP progress notifications.
`modelgate_chat_stream` consumes ModelGate's server-sent event stream and forwards text deltas as
`notifications/progress` messages (coalesced to at most one every ~150 ms or 64 characters). It
then returns the complete answer with the final usage chunk. Clients that don't send a
`progressToken` still get the full result.

- **Cancellation:** cancelling the tool call aborts the HTTP stream, and ModelGate aborts the
  provider call, so tokens stop being generated. The request is logged as `CANCELLED`.
- **Partial failure:** if the stream ends without final usage, the result has `complete: false`
  and a warning.
- **Timeouts:** `MODELGATE_TIMEOUT_MS` limits the wait for the first byte, and then the idle time
  between chunks. A long generation that keeps streaming is not cut off.
- **Limits:** ModelGate streams text only, so use `modelgate_chat` for tool calling. Projects with
  secret or PII redaction set to ENFORCE refuse streaming (`stream_unavailable`).

## Authentication and scopes

ModelGate enforces authorization. This server never makes access decisions of its own.

- Each key belongs to exactly one ModelGate project. A key for project A cannot reach project B's
  data, and ModelGate answers another project's request id with `not_found`.
- Keys carry **scopes**: `inference:write`, `models:read`, `usage:read`, `requests:read` and
  `admin`. The **Integration (MCP / agents)** preset grants the first four. MCP clients should
  never hold an `admin` key.
- Keys created before scopes existed are full-access keys. They work, but
  `modelgate-mcp check` recommends switching.
- Remote mode never uses a key that lives on the server unless you configure
  [token mode](docs/REMOTE-MCP.md). By default, each caller sends its own ModelGate key.

## Configuration reference

| Variable                                    | Default                      | Description                                                                                     |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `MODELGATE_KEY`                             | _(required for stdio)_       | ModelGate API key (`mg_…`). `MODELGATE_API_KEY` also works.                                     |
| `MODELGATE_BASE_URL`                        | `https://gw.modelgatehq.com` | Gateway origin. Must be https (http only for localhost). A trailing `/v1` is accepted.          |
| `MODELGATE_DEFAULT_MODEL`                   | —                            | Model to use when a call leaves out `model`                                                     |
| `MODELGATE_DEFAULT_PROVIDER`                | —                            | `OPENAI`, `ANTHROPIC`, `GEMINI` or `AZURE_OPENAI`. Defaults to the project's primary provider.  |
| `MODELGATE_TIMEOUT_MS`                      | `120000`                     | Request timeout, and idle timeout between stream chunks (1000–600000)                           |
| `MODELGATE_MAX_RETRIES`                     | `2`                          | Retries for safe-to-retry failures (0–5). See [Errors](#errors).                                |
| `MODELGATE_LOG_LEVEL`                       | `info`                       | `error`, `warn`, `info` or `debug`. JSON lines on stderr.                                       |
| `MODELGATE_LOG_CONTENT`                     | `false`                      | Opt in to logging prompts and responses at debug level                                          |
| `MODELGATE_ENVIRONMENT`                     | —                            | Attribution tag, sent as `X-ModelGate-Environment`                                              |
| `MODELGATE_MAX_OUTPUT_CHARS`                | `100000`                     | Maximum assistant text returned per call                                                        |
| `MODELGATE_MCP_HOST` / `MODELGATE_MCP_PORT` | `127.0.0.1` / `3333`         | Remote server bind address                                                                      |
| `MODELGATE_MCP_AUTH`                        | `passthrough`                | `passthrough` (each caller sends its own key) or `token`                                        |
| `MODELGATE_MCP_AUTH_TOKENS`                 | —                            | Token mode: comma-separated client tokens, each at least 32 characters                          |
| `MODELGATE_MCP_ALLOWED_HOSTS`               | loopback names               | Allowed `Host` values (DNS-rebinding protection). Required when binding a non-loopback address. |
| `MODELGATE_MCP_ALLOWED_ORIGINS`             | loopback names               | Allowed browser `Origin` hostnames                                                              |
| `MODELGATE_MCP_RATE_LIMIT`                  | `120`                        | Requests per minute per caller (remote)                                                         |
| `MODELGATE_MCP_MAX_BODY_BYTES`              | `1048576`                    | Maximum MCP request body size (remote)                                                          |
| `MODELGATE_ALLOW_CUSTOM_BASE_URL`           | `false`                      | Remote mode only: allow a non-default `MODELGATE_BASE_URL`                                      |

CLI commands: `modelgate-mcp` (stdio), `modelgate-mcp http [--host] [--port]`,
`modelgate-mcp check [--http]`, `--version` and `--help`. For programmatic use, see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#programmatic-use).

### Remote server

```bash
MODELGATE_MCP_HOST=0.0.0.0 MODELGATE_MCP_ALLOWED_HOSTS=mcp.example.com npx -y modelgate-mcp http
```

The endpoint is `POST /mcp` and the health check is `GET /healthz`. Put it behind TLS. Deployment,
auth modes and hardening are covered in [docs/REMOTE-MCP.md](docs/REMOTE-MCP.md).

## Errors

Failures come back as MCP tool results with `isError: true`, so the model can read them and
correct course. Each one has a readable message and a JSON block:

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "…",
    "retryable": false,
    "http_status": 403,
    "request_id": "…",
    "details": { "required_scope": "usage:read" }
  }
}
```

Codes: `auth_invalid`, `insufficient_scope`, `invalid_request`, `invalid_model`,
`provider_required`, `provider_not_configured`, `rate_limited`, `quota_exceeded`,
`payload_too_large`, `guardrail_blocked`, `stream_unavailable`, `provider_error`,
`provider_timeout`, `gateway_error`, `gateway_timeout`, `network_error`, `cancelled`,
`malformed_response`, `not_found`, `endpoint_unavailable`, `internal_error`.

**Retries.** Read tools retry network errors, 429 and 5xx responses, using exponential backoff with
jitter and honouring `Retry-After`. Inference is billable, so it retries only when nothing can
have reached a provider: a 429 from ModelGate, or a connection that never opened. It never retries
a 5xx or a timeout, because that could run and bill the generation twice. ModelGate already
retries the provider and fails over on its own side.

## Security

- The key is never logged, echoed, or returned. Logs, errors and results are all scrubbed of
  `mg_…` keys and bearer tokens.
- Logs go to stderr only, so stdout stays pure MCP protocol. Prompt and response content is not
  logged unless you set `MODELGATE_LOG_CONTENT=true`.
- `MODELGATE_BASE_URL` is https-only, cannot carry credentials, queries or paths, and redirects
  are refused. In remote mode, pointing it elsewhere needs an explicit opt-in.
- The remote server is never an open proxy. Every request needs a bearer credential, and the
  server also enforces `Host`/`Origin` validation, per-caller rate limits, body limits and a cap
  on concurrent requests.

Threat model and details: [docs/SECURITY.md](docs/SECURITY.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Development

```bash
git clone https://github.com/razdgann/modelgate-mcp.git && cd modelgate-mcp
npm install
npm run build
MODELGATE_KEY=YOUR_MODELGATE_KEY npm start        # stdio server from dist/
npm run dev                                        # tsx watch mode
```

Scripts: `build`, `start`, `dev`, `typecheck`, `lint`, `format`, `test`, `test:unit`,
`test:integration`, `test:e2e`, `test:live`, `check:package`, and `verify` (all checks). See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Testing

```bash
npm test              # unit + integration (mock ModelGate gateway)
npm run test:e2e      # builds, then drives dist/cli.js over stdio and HTTP as a child process
MODELGATE_KEY=YOUR_MODELGATE_KEY npm run test:live   # real gateway: one short chat + one short stream
```

`test:live` checks startup, discovery, models, real chat, streaming, usage, request id,
`source=mcp` attribution, the request record, safe failure with a bad key, and that no secret
appears in any output. Set `MODELGATE_BASE_URL` to test another deployment.

## Publishing

Releases go through GitHub Actions with npm provenance: a `v*` tag runs
`.github/workflows/release.yml`. Before tagging, run `npm run verify` and bump `version` in both
`package.json` and `src/version.ts`. The one-time npm setup is described in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#publishing).

## Troubleshooting

| Symptom                                                       | Fix                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODELGATE_KEY is not set`                                    | Add `MODELGATE_KEY` to the `env` block of your client config, not only to your shell.                                                                                      |
| `auth_invalid`                                                | The key is wrong or was revoked. Create a new one and run `npx -y modelgate-mcp check`.                                                                                    |
| `insufficient_scope`                                          | The key lacks the scope named in `details.required_scope`. Create an **Integration (MCP / agents)** key.                                                                   |
| `provider_required`                                           | Pass `provider`, set `MODELGATE_DEFAULT_PROVIDER`, or choose a primary provider in ModelGate **Settings**.                                                                 |
| `provider_not_configured` / `invalid_model`                   | Run `modelgate_models`: use a model whose provider shows as available, or add that provider's credential.                                                                  |
| `endpoint_unavailable`                                        | Your gateway doesn't have the integration API yet. Chat still works.                                                                                                       |
| Anthropic or Gemini requests fail with `provider_error` (400) | ModelGate forwards messages unchanged. With Anthropic, use only user/assistant turns (no `system` role). The OpenAI format is fully supported for OPENAI and AZURE_OPENAI. |
| Server doesn't appear in Claude Desktop                       | Check the JSON syntax, restart Claude Desktop fully, and read `~/Library/Logs/Claude/mcp-server-modelgate.log`.                                                            |
| `npx` is slow or can't find Node                              | Install Node 22 or newer. Some GUI apps don't inherit your shell `PATH`; use an absolute path such as `"command": "/usr/local/bin/npx"`.                                   |
| Need more detail                                              | Set `MODELGATE_LOG_LEVEL=debug`. It logs request ids, statuses and timings, but never keys or content.                                                                     |

## License

MIT © ModelGate
