# Oracle app

Public Oracle web app for multichain reads and prepare-only actions.

## Surfaces

- Oracle task composer for research and prepare-only requests.
- Portfolio balances, chain coverage, and allocation charts.
- Approval review plus unsigned ERC-20/ERC-721 revoke preparation.
- Swap quote and unsigned preparation.
- Agent Connect read-MCP configuration for Hermes and other MCP clients.
- Local receipts, alert/prepare/owner-arm campaign requests, and route coverage.

## Boundary

This app does not hold keys, seed phrases, private RPC credentials, or policy
state. It reads through Oracle's loopback public plane and prepares inert
artifacts for a user-controlled wallet. It exposes no sign or broadcast route.

Sensitive custody code stays outside this public package.

The app is public to everyone. Locals Only ownership only waives Oracle's
integrator fee. Any hosted deployment still needs ordinary authentication and
per-user isolation for private user state.

## Development

From the monorepo root:

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm run build
```

Or run only the app:

```bash
npm --workspace @oracle-agent/app run dev
```
