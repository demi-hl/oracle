# Oracle AI-client connectors

ChatGPT is hosted and can NEVER sign or reach your keys. This connector is read/prepare only; anything it prepares is unsigned until you sign it locally.

```bash
oracle mcp print --target claude-code
oracle mcp install claude-code
oracle mcp install codex
oracle mcp install chatgpt
oracle mcp install claude-code --with-control   # requires local operator
```

Oracle does not create tunnels for hosted clients.
