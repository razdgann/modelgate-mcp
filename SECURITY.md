# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through this repository's **Security → Report a
vulnerability** flow (GitHub private advisory), or email **support@modelgatehq.com**. The
coordinated disclosure policy is at <https://modelgatehq.com/security>.

Do not open a public issue, and do not include real API keys, customer data, or prompt content.
Include the affected version, the impact, and a minimal reproduction that uses placeholder
credentials (`YOUR_MODELGATE_KEY`).

## Supported versions

Security fixes go into the latest published minor version.

## Scope

In scope: this package's credential handling, remote transport authentication, input validation,
log and error redaction, and anything that lets an MCP client act beyond its ModelGate key.

Authorization, tenant isolation, guardrails and provider access are enforced by the ModelGate
gateway. Report issues there through the same channel. The threat model is in
[docs/SECURITY.md](docs/SECURITY.md).
