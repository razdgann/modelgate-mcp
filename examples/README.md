# Client configuration examples

| File                                         | Client                            | Transport    |
| -------------------------------------------- | --------------------------------- | ------------ |
| `claude_desktop_config.json`                 | Claude Desktop                    | stdio        |
| `claude-code.mcp.json`                       | Claude Code (project `.mcp.json`) | stdio        |
| `cursor.mcp.json` / `cursor-remote.mcp.json` | Cursor                            | stdio / HTTP |
| `vscode.mcp.json` / `vscode-remote.mcp.json` | VS Code (`.vscode/mcp.json`)      | stdio / HTTP |

Replace `YOUR_MODELGATE_KEY`, or export `MODELGATE_KEY` where the file reads it from the
environment. Replace `https://mcp.example.com/mcp` with your own [remote server](../docs/REMOTE-MCP.md).
