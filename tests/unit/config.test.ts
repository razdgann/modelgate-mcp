import { beforeEach, describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/errors/errors.js";
import { clearRegisteredSecrets, redactString } from "../../src/logging/redact.js";

const KEY = "mg_abc123def456_secretsecretsecret";
const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error("expected ConfigError");
};

describe("loadConfig", () => {
  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it("applies defaults for stdio with a key", () => {
    const c = loadConfig({ mode: "stdio", env: { MODELGATE_KEY: KEY } });
    expect(c.baseUrl).toBe("https://gw.modelgatehq.com");
    expect(c.timeoutMs).toBe(120_000);
    expect(c.maxRetries).toBe(2);
    expect(c.logLevel).toBe("info");
    expect(c.logContent).toBe(false);
    expect(c.http.host).toBe("127.0.0.1");
    expect(c.http.authMode).toBe("passthrough");
  });

  it("accepts MODELGATE_API_KEY as an alias", () => {
    expect(loadConfig({ mode: "stdio", env: { MODELGATE_API_KEY: KEY } }).apiKey).toBe(KEY);
  });

  it("requires a key for stdio, with an actionable message", () => {
    const p = problems(() => loadConfig({ mode: "stdio", env: {} }));
    expect(p.join()).toMatch(/MODELGATE_KEY is not set/);
    expect(p.join()).toMatch(/dashboard/);
  });

  it("rejects a malformed key without echoing it", () => {
    const bad = "sk-thisisnotamodelgatekey1234567890";
    let message = "";
    try {
      loadConfig({ mode: "stdio", env: { MODELGATE_KEY: bad } });
    } catch (x) {
      message = (x as ConfigError).message;
    }
    expect(message).toMatch(/does not look like a ModelGate API key/);
    expect(message).not.toContain(bad);
  });

  it("registers the key for redaction", () => {
    loadConfig({ mode: "stdio", env: { MODELGATE_KEY: KEY } });
    expect(redactString(`oops ${KEY} leaked`)).not.toContain(KEY);
  });

  it("validates numbers, enums and booleans", () => {
    const p = problems(() =>
      loadConfig({
        mode: "stdio",
        env: {
          MODELGATE_KEY: KEY,
          MODELGATE_TIMEOUT_MS: "abc",
          MODELGATE_MAX_RETRIES: "99",
          MODELGATE_LOG_LEVEL: "trace",
          MODELGATE_LOG_CONTENT: "maybe",
          MODELGATE_DEFAULT_PROVIDER: "cohere",
          MODELGATE_ENVIRONMENT: "prod env!",
        },
      }),
    );
    expect(p).toHaveLength(6);
  });

  it("normalizes the base URL and strips /v1", () => {
    expect(
      loadConfig({
        mode: "stdio",
        env: { MODELGATE_KEY: KEY, MODELGATE_BASE_URL: "https://gw.modelgatehq.com/v1/" },
      }).baseUrl,
    ).toBe("https://gw.modelgatehq.com");
    expect(
      loadConfig({ mode: "stdio", env: { MODELGATE_KEY: KEY, MODELGATE_BASE_URL: "http://localhost:3001" } })
        .baseUrl,
    ).toBe("http://localhost:3001");
  });

  it("rejects unsafe base URLs", () => {
    for (const u of [
      "http://gw.modelgatehq.com",
      "https://user:pass@gw.modelgatehq.com",
      "https://gw.modelgatehq.com/?x=1",
      "https://gw.modelgatehq.com/some/path",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(
        problems(() => loadConfig({ mode: "stdio", env: { MODELGATE_KEY: KEY, MODELGATE_BASE_URL: u } }))
          .length,
        u,
      ).toBe(1);
    }
  });

  it("http passthrough needs no server key", () => {
    const c = loadConfig({ mode: "http", env: {} });
    expect(c.apiKey).toBeUndefined();
    expect(c.http.allowedHosts).toEqual(["localhost", "127.0.0.1", "[::1]"]);
  });

  it("http token mode requires a key and strong tokens", () => {
    expect(problems(() => loadConfig({ mode: "http", env: { MODELGATE_MCP_AUTH: "token" } }))).toHaveLength(
      2,
    );
    expect(
      problems(() =>
        loadConfig({
          mode: "http",
          env: { MODELGATE_MCP_AUTH: "token", MODELGATE_KEY: KEY, MODELGATE_MCP_AUTH_TOKENS: "short" },
        }),
      ),
    ).toHaveLength(1);
    const ok = loadConfig({
      mode: "http",
      env: { MODELGATE_MCP_AUTH: "token", MODELGATE_KEY: KEY, MODELGATE_MCP_AUTH_TOKENS: "t".repeat(40) },
    });
    expect(ok.http.authTokens).toHaveLength(1);
  });

  it("non-loopback binds require explicit allowed hosts", () => {
    expect(
      problems(() => loadConfig({ mode: "http", env: { MODELGATE_MCP_HOST: "0.0.0.0" } })).join(),
    ).toMatch(/MODELGATE_MCP_ALLOWED_HOSTS/);
    const c = loadConfig({
      mode: "http",
      env: { MODELGATE_MCP_HOST: "0.0.0.0", MODELGATE_MCP_ALLOWED_HOSTS: "mcp.example.com" },
    });
    expect(c.http.allowedHosts).toEqual(["mcp.example.com"]);
  });

  it("remote mode refuses a custom base URL unless explicitly allowed (SSRF guard)", () => {
    expect(
      problems(() =>
        loadConfig({ mode: "http", env: { MODELGATE_BASE_URL: "https://evil.example.com" } }),
      ).join(),
    ).toMatch(/MODELGATE_ALLOW_CUSTOM_BASE_URL/);
    const c = loadConfig({
      mode: "http",
      env: { MODELGATE_BASE_URL: "https://mg.internal.example", MODELGATE_ALLOW_CUSTOM_BASE_URL: "true" },
    });
    expect(c.baseUrl).toBe("https://mg.internal.example");
  });

  it("programmatic overrides win over env", () => {
    const c = loadConfig({
      mode: "stdio",
      env: { MODELGATE_KEY: KEY, MODELGATE_TIMEOUT_MS: "5000" },
      overrides: { timeoutMs: 9000 },
    });
    expect(c.timeoutMs).toBe(9000);
  });

  it("describeConfig never includes secrets", () => {
    const c = loadConfig({
      mode: "http",
      env: { MODELGATE_MCP_AUTH: "token", MODELGATE_KEY: KEY, MODELGATE_MCP_AUTH_TOKENS: "z".repeat(40) },
    });
    const s = JSON.stringify(describeConfig(c, "http"));
    expect(s).not.toContain(KEY);
    expect(s).not.toContain("z".repeat(40));
    expect(s).toContain('"api_key_configured":true');
  });
});
