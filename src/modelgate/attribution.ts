import { PACKAGE_NAME, VERSION } from "../version.js";
import { RESERVED_METADATA_KEYS } from "../schemas/common.js";

/**
 * ModelGate attribution for MCP traffic, using ModelGate's existing mechanism
 * (docs/GATEWAY.md "Metadata"): X-ModelGate-* headers plus the request body
 * `metadata` bag. Headers win over body keys server-side, so `source=mcp`
 * cannot be overridden by caller-supplied metadata.
 *
 *   source               "mcp"                       (indexed column; usage-by-integration)
 *   integration          "modelgate-mcp"
 *   integration_version  package version
 *   mcp_client           MCP client name from the handshake (e.g. "claude-code")
 *   mcp_client_version   its version
 *   mcp_transport        "stdio" | "http"
 *   mcp_tool             the tool that issued the call
 *   correlation_id       local id, also returned to the caller
 */
export const SOURCE = "mcp";

export interface ClientIdentity {
  name?: string | undefined;
  version?: string | undefined;
}

export interface AttributionInput {
  transport: "stdio" | "http";
  tool: string;
  correlationId: string;
  client?: ClientIdentity | undefined;
  environment?: string | undefined;
  feature?: string | undefined;
  conversationId?: string | undefined;
  userMetadata?: Record<string, string | number | boolean> | undefined;
}

export interface Attribution {
  headers: Record<string, string>;
  metadata: Record<string, string | number | boolean>;
}

const RESERVED = new Set<string>(RESERVED_METADATA_KEYS);

/** Client-reported names are untrusted: keep a conservative charset and length. */
export function sanitizeLabel(v: string | undefined, max = 64): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .replace(/[^\w.@/+ -]/g, "")
    .trim()
    .slice(0, max);
  return s || undefined;
}

export function userAgent(): string {
  return `${PACKAGE_NAME}/${VERSION} (node ${process.versions.node})`;
}

export function buildAttribution(input: AttributionInput): Attribution {
  const headers: Record<string, string> = {
    "x-modelgate-source": SOURCE,
    "x-modelgate-integration": PACKAGE_NAME,
  };
  if (input.environment) headers["x-modelgate-environment"] = input.environment;
  if (input.feature) headers["x-modelgate-feature"] = input.feature;
  if (input.conversationId) headers["x-modelgate-conversation-id"] = input.conversationId;

  const metadata: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input.userMetadata ?? {})) {
    if (!RESERVED.has(k) && k !== "__proto__" && k !== "constructor" && k !== "prototype") metadata[k] = v;
  }
  metadata.source = SOURCE;
  metadata.integration = PACKAGE_NAME;
  metadata.integration_version = VERSION;
  metadata.mcp_transport = input.transport;
  metadata.mcp_tool = input.tool;
  metadata.correlation_id = input.correlationId;
  const clientName = sanitizeLabel(input.client?.name);
  const clientVersion = sanitizeLabel(input.client?.version, 32);
  if (clientName) metadata.mcp_client = clientName;
  if (clientVersion) metadata.mcp_client_version = clientVersion;
  return { headers, metadata };
}
