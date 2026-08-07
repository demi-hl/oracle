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

The app does not currently implement Locals-holder authentication. Do not expose
it as a holder-gated hosted product until
[`packages/oracle/docs/holder-beta.md`](../../packages/oracle/docs/holder-beta.md)
passes against the deployed environment.

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
