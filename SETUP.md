# Oracle setup

The canonical end-user setup guide ships with the npm package:

- [Standalone CLI, authentication, optional Hermes, local servers, fee waiver,
  Buzz, and troubleshooting](packages/oracle/SETUP.md)
- [CLI reference](packages/oracle/docs/cli.md)
- [Public API and environment surface](packages/oracle/docs/public-surface.md)
- [Locals Only 0% fee waiver](packages/oracle/docs/locals-only-fee-waiver.md)
- [Hyperliquid builder code](packages/oracle/docs/hyperliquid-builder-code.md)
- [Buzz integration](packages/oracle/docs/buzz-integration.md)

## Fast path

```bash
npm i -g @oracle-agent/oracle            # Node >= 20.19
oracle --version
oracle auth login claude               # or codex / grok
oracle
oracle doctor
```

Oracle's public install is standalone and prepare-only. Hermes is optional. The
private owner-operated signer/executor is not published on npm and is not part
of public onboarding. Linux, Windows, and macOS apps are in beta. Locals Only
holders receive a 0% Oracle integrator fee; access remains public.

## Build this repository

```bash
npm ci --no-audit --no-fund
npm run gate:release
npm run test:boundary
npm test
npm run typecheck
npm run build
npm run scan:secrets
```

The repository can contain an unreleased next version. npm `latest` is the
public CLI installation source of truth.
