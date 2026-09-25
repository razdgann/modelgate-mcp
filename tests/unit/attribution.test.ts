import { describe, expect, it } from "vitest";
import { buildAttribution, sanitizeLabel, userAgent } from "../../src/modelgate/attribution.js";
import { VERSION } from "../../src/version.js";

describe("attribution", () => {
  const base = { transport: "stdio" as const, tool: "modelgate_chat", correlationId: "mcp_1" };

  it("tags every request as source=mcp via ModelGate's headers and metadata", () => {
    const a = buildAttribution({
      ...base,
      client: { name: "claude-code", version: "2.1.0" },
      environment: "prod",
      feature: "summarize",
      conversationId: "conv-1",
    });
    expect(a.headers).toEqual({
      "x-modelgate-source": "mcp",
      "x-modelgate-integration": "modelgate-mcp",
      "x-modelgate-environment": "prod",
      "x-modelgate-feature": "summarize",
      "x-modelgate-conversation-id": "conv-1",
    });
    expect(a.metadata).toEqual({
      source: "mcp",
      integration: "modelgate-mcp",
      integration_version: VERSION,
      mcp_transport: "stdio",
      mcp_tool: "modelgate_chat",
      correlation_id: "mcp_1",
      mcp_client: "claude-code",
      mcp_client_version: "2.1.0",
    });
  });

  it("user metadata cannot override reserved keys", () => {
    const a = buildAttribution({
      ...base,
      userMetadata: {
        source: "evil",
        integration: "x",
        mcp_tool: "y",
        correlation_id: "z",
        workflow_id: "wf",
      },
    });
    expect(a.metadata.source).toBe("mcp");
    expect(a.metadata.integration).toBe("modelgate-mcp");
    expect(a.metadata.mcp_tool).toBe("modelgate_chat");
    expect(a.metadata.correlation_id).toBe("mcp_1");
    expect(a.metadata.workflow_id).toBe("wf");
  });

  it("sanitizes untrusted client labels", () => {
    expect(sanitizeLabel("evil\nname\u0000<script>")).toBe("evilnamescript");
    expect(sanitizeLabel("x".repeat(200))?.length).toBe(64);
    expect(sanitizeLabel("")).toBeUndefined();
    expect(sanitizeLabel(undefined)).toBeUndefined();
  });

  it("sends a versioned user agent", () => {
    expect(userAgent()).toMatch(new RegExp(`^modelgate-mcp/${VERSION.replace(/\./g, "\\.")} \\(node `));
  });
});
