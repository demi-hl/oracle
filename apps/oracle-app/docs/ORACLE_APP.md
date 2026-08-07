# Oracle app public boundary

Oracle app is the public product shell for read and prepare flows.

## Public package contains

- Product navigation and presentation.
- Task composer, portfolio, approvals, revoke preparation, swaps, Agent Connect,
  receipts, campaigns, and route coverage.
- Server routes under `/api/oracle/*` that bridge to read-only data, unsigned
  preparation, or read-only local signer status.
- Self-hosted public fonts and icons.

## Public package must not contain

- Private keys, seed phrases, API tokens, or signing certificates.
- Policy grants, custody caps, or wallet executor internals.
- Private infrastructure dashboards or local machine control surfaces.
- Hardcoded personal hostnames or local filesystem paths.
- Any claim that Locals Only ownership gates product access. It only waives
  Oracle's integrator fee.

## Deployment status

The source app is public-access. A hosted deployment with private user state
still needs ordinary authentication and per-user isolation.
The static website, app build, and loopback API are separate artifacts; one
being live does not prove the others are live.

## Verification

Run from monorepo root:

```bash
npm run typecheck
npm run build
npm run scan:secrets
```

After build, inspect emitted app chunks for forbidden private-surface terms before publishing.
