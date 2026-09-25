# Remote MCP (Streamable HTTP)

`modelgate-mcp http` serves MCP over Streamable HTTP, the MCP 2026-07-28 remote transport. It uses
the SDK's `createMcpHandler`, which is stateless (one server instance per request) and also serves
2025-era clients through the SDK's stateless fallback. The deprecated HTTP+SSE transport is not
offered.

| Path       | Method                                                       | Auth   | Purpose                                                      |
| ---------- | ------------------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `/mcp`     | POST (and the GET/DELETE session operations the SDK answers) | Bearer | MCP endpoint                                                 |
| `/healthz` | GET, HEAD                                                    | none   | Liveness: `{"ok":true,"name":"modelgate-mcp","version":"…"}` |

## Auth modes

### Passthrough (default): multi-tenant

Each client sends **its own ModelGate key**:

```
Authorization: Bearer mg_…
```

The server checks the key with ModelGate (`GET /v1/me`, cached briefly by hash) and serves that
request with that key only. Scopes and tenant isolation are ModelGate's, and the server holds no
ModelGate credential.

```bash
MODELGATE_MCP_HOST=0.0.0.0 \
MODELGATE_MCP_ALLOWED_HOSTS=mcp.example.com \
npx -y modelgate-mcp http --port 3333
```

### Token: single tenant

The server holds one `MODELGATE_KEY`. Clients authenticate with a shared token, never with the
ModelGate key.

```bash
MODELGATE_MCP_AUTH=token \
MODELGATE_KEY=YOUR_MODELGATE_KEY \
MODELGATE_MCP_AUTH_TOKENS="$(openssl rand -hex 32)" \
npx -y modelgate-mcp http
```

Rotate tokens by listing both the old and new token, comma-separated, then removing the old one.

## Hardening checklist

- Terminate TLS in front of the server (a reverse proxy or load balancer). Do not expose plain
  HTTP publicly.
- Set `MODELGATE_MCP_ALLOWED_HOSTS` to the public hostname. It is required when binding a
  non-loopback address, and protects against DNS rebinding.
- Set `MODELGATE_MCP_ALLOWED_ORIGINS` only if browser-based clients connect.
- Keep `MODELGATE_BASE_URL` at its default. A custom gateway needs
  `MODELGATE_ALLOW_CUSTOM_BASE_URL=true`.
- Tune `MODELGATE_MCP_RATE_LIMIT` and `MODELGATE_MCP_MAX_BODY_BYTES`. With multiple replicas, also
  rate-limit at the proxy (the built-in limiter is per process).
- Point liveness probes at `/healthz`. `SIGTERM` stops accepting connections and aborts in-flight
  MCP exchanges, then exits (after 15 s at most).

## Container example

```dockerfile
FROM node:22-alpine
RUN npm install -g modelgate-mcp@0.1.0
ENV MODELGATE_MCP_HOST=0.0.0.0 MODELGATE_MCP_PORT=3333
EXPOSE 3333
USER node
CMD ["modelgate-mcp", "http"]
```

Run it with `-e MODELGATE_MCP_ALLOWED_HOSTS=mcp.example.com`.

## Client configuration

- Claude Code: `claude mcp add --transport http modelgate https://mcp.example.com/mcp --header "Authorization: Bearer YOUR_MODELGATE_KEY"`
- Cursor: `{"mcpServers":{"modelgate":{"url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ${env:MODELGATE_KEY}"}}}}`
- VS Code: `{"servers":{"modelgate":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ${input:modelgate-key}"}}}}`
- Claude Desktop and claude.ai custom connectors authenticate with OAuth only. ModelGate has no
  OAuth authorization server, so use the local stdio configuration for Claude Desktop.

## Attribution note

Requests are tagged `mcp_transport: "http"`. MCP 2026-07-28 clients send their identity with every
request, so `mcp_client` is recorded. For 2025-era clients over stateless HTTP, the identity exists
only in their `initialize` request, so `mcp_client` is omitted.
