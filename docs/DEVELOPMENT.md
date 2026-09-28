# Development

## Setup

```bash
npm install
npm run build
npm run verify   # typecheck, lint, format check, unit + integration, build, e2e, package checks
```

Node 22.12 or newer is required (`.nvmrc` pins 22 for development).

## Layout

```
src/
  cli.ts            CLI entry (bin): stdio | http | check | --help | --version
  index.ts          Programmatic API
  server.ts         MCP server factory (one instance per connection/request)
  config/           Env + programmatic config, validation
  transports/       stdio.ts, http.ts
  tools/            chat.ts (chat + stream), read.ts (models, usage, request), context.ts
  resources/        modelgate://models, integration, requests/{id}
  prompts/          investigate_request, usage_report, compare_models
  modelgate/        client.ts (HTTP), api.ts (typed endpoints), sse.ts, retry.ts, attribution.ts
  schemas/          Zod input/output schemas
  errors/           Error codes, ModelGate → MCP mapping, tool error results
  security/         baseUrl.ts, remoteAuth.ts, rateLimit.ts
  logging/          logger.ts, redact.ts
tests/
  unit/             Pure functions (config, schemas, errors, retry, redaction, attribution, SSE, auth)
  integration/      MCP client ↔ server ↔ mock ModelGate (in-memory and HTTP transports)
  e2e/              Built dist/cli.js as a child process (stdio + HTTP)
  helpers/          Mock ModelGate gateway, MCP harness
scripts/            Build helpers, package check, live E2E
```

## Running locally against a local ModelGate

Start the ModelGate API (see the ModelGate repository README). `MOCK_PROVIDERS=1` avoids provider
spend. Then:

```bash
MODELGATE_BASE_URL=http://localhost:3001 MODELGATE_KEY=YOUR_MODELGATE_KEY npm run test:live
```

`http://` is accepted only for loopback hosts.

## Programmatic use

```ts
import { createServerFactory, loadConfig, createLogger } from "modelgate-mcp";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const config = loadConfig({ mode: "stdio", overrides: { apiKey: process.env.MODELGATE_KEY } });
serveStdio(createServerFactory({ config, logger: createLogger({ level: "info" }), transport: "stdio" }));
```

`startStdio(config, logger)` and `startHttp(config, logger)` are exported too.

## Conventions

- Nothing may write to stdout except the MCP transport. Use `src/logging`; ESLint forbids
  `console`.
- Business logic belongs in ModelGate. If a capability is missing, add it to the ModelGate API;
  never compute it here.
- Every new tool input needs a bounded schema and a description written for the calling model.
- Errors must be `ModelGateMcpError` with a code from `ERROR_CODES`.

## Publishing

Publishing is automated by `.github/workflows/release.yml` and runs when a `v*` tag is pushed. It
runs `npm run verify` and then `npm publish --provenance --access public`.

Requirements: the GitHub repository must be **public** (npm only generates provenance for public
source repositories), and the publishing npm account is `modelgate`.

One-time setup:

1. **First release (token):** the package does not exist on npm yet, so trusted publishing cannot
   be configured. Create a granular access token on npmjs.com (read and write for packages, with
   "bypass 2FA" enabled, 7-day expiry) and store it as the `NPM_TOKEN` repository secret.
2. **After the first release (trusted publishing):** on npmjs.com, open `modelgate-mcp` →
   Settings → Trusted publisher → GitHub Actions. Enter organization `razdgann`, repository
   `modelgate-mcp`, workflow `release.yml` and environment `npm`. Then delete the `NPM_TOKEN`
   secret and revoke the token. The workflow then authenticates via OIDC with no stored secret.

To release:

1. Update `version` in `package.json` **and** `src/version.ts` (a test enforces that they match),
   and update `CHANGELOG.md`.
2. Run `npm run verify`.
3. Commit, tag `vX.Y.Z`, and push the tag.

`npm pack --dry-run` shows exactly what will be published: `dist/` (no source maps), `README.md`,
`LICENSE`, `SECURITY.md`, `CHANGELOG.md`.
