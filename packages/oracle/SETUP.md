# Oracle setup

Oracle's public CLI is a standalone, prepare-only multichain agent. It can read,
research, quote, simulate, and build unsigned artifacts. It does not need Hermes,
it does not accept wallet private keys, and it does not broadcast transactions.

The owner-operated signer/executor is private infrastructure. It is not published
on npm and is not part of public onboarding.

## Requirements

- Node.js `20.19.0` or newer
- npm
- A supported model login or API key for chat
- A user-controlled wallet only when reviewing and signing a prepared artifact

Linux, Windows, and macOS apps are in beta.

## 1. Install the standalone CLI

```bash
npm i -g @oracle-agent/oracle
oracle --version
```

npm `latest` is the public CLI installation source of truth. Locals Only
ownership is not required to install or use Oracle; holders receive a 0% Oracle
integrator fee.

For a project-local library install instead:

```bash
npm i @oracle-agent/oracle
```

The package declares this floor through `engines`; `oracle doctor` treats an
unsupported Node runtime as blocking. npm may only warn unless the user's npm
configuration enables strict engine checks, so verify `node --version` yourself.

## 2. Authenticate a model provider

### OAuth

```bash
oracle auth login claude
# or
oracle auth login codex
oracle auth login grok
```

The command opens the provider's authorization flow and selects its default
model. Use `--no-browser` when the browser must be opened manually.

### API key

```bash
oracle auth api-key openrouter
# also supported: openai, xai, deepseek, gemini, custom
```

Interactive API-key entry is hidden. Do not put a key directly in the command
line, shell history, a screenshot, or Oracle chat. For controlled automation,
pipe the secret over stdin instead of passing it as an argument:

```bash
printf '%s\n' "$OPENROUTER_API_KEY" | oracle auth api-key openrouter --stdin
```

Check configuration without revealing credentials:

```bash
oracle auth status
oracle model --show
```

OAuth credentials and stored API keys use the OS credential store when
available, with a private `0600` local fallback.

## 3. Open Oracle

```bash
oracle
```

Useful first commands:

```bash
oracle chain list
oracle chain use hyperliquid
oracle chain show
oracle doctor
```

Inside chat:

- `/chain` lists or selects the active chain.
- `/model` changes the model without changing the Oracle persona.
- `/setup` opens optional messaging setup.

A model response is not authorization, a prepared object is not a transaction,
and a submitted transaction is not a confirmed receipt.

## Public capability boundary

| Surface | Available to a public install | Custody |
|---|---:|---|
| Chat, research, market data | yes | none |
| Quotes and simulations | yes | none |
| Unsigned transaction / typed-data preparation | yes | user's wallet reviews and signs |
| Signing, submission, broadcast | no | private owner-operated boundary only |
| Automatic trading | no | not a public capability |

Never paste a seed phrase, private key, hardware-wallet recovery phrase, vault
passphrase, signer token, bot token, or provider credential into chat.

## Optional Hermes integration

Hermes is optional. Add it only if you want specialist profiles, messaging
channels, durable sessions, or the MCP-based local read plane:

```bash
oracle bootstrap
oracle init                 # dry run
oracle init --apply
oracle data serve
oracle doctor
```

`oracle bootstrap` installs an isolated Hermes compatibility runtime under
Oracle's config directory and never modifies system Python. `oracle init
--apply` writes profiles and a local HMAC attestation secret; it does not write a
wallet key.

The data service binds to `127.0.0.1:8787`. Keep it on loopback.

## Optional public HTTP plane

```bash
oracle public serve --port 8799
```

The public plane binds to `127.0.0.1` and exposes read, connect, grant,
portfolio, approval, prepare, Buzz-auth, and audit contracts. It has no signer,
key, send, execute, or broadcast route.

The service is rate limited but unauthenticated and must not be exposed directly
to the internet, LAN, or tailnet. A hosted deployment needs a controlled reverse
proxy, TLS, edge limits, authentication, and per-user isolation.

Verify liveness only after starting it:

```bash
curl -fsS http://127.0.0.1:8799/public/health
curl -fsS http://127.0.0.1:8799/public/buzz
```

A static Oracle website does not imply that this API is running.

## Optional messaging

```bash
oracle setup
oracle setup telegram --allowed-users <telegram-user-id>
oracle setup status
oracle setup gateway start
```

Interactive bot-token entry is hidden. Do not use `--token` in a normal shell;
arguments can be retained in history or visible to other local processes. Do not
run one shared messaging bot without authentication and per-user session isolation.

## Public wallet addresses and portfolio reads

Portfolio and approval reads use public addresses only:

```bash
export ORACLE_EVM_ADDRESS=0x...
export ORACLE_SOLANA_ADDRESS=...
export ORACLE_BITCOIN_ADDRESS=bc1...
export ORACLE_HYPERLIQUID_ADDRESS=0x...  # optional; EVM address is the fallback
oracle data serve
```

Missing address families are reported as `not-configured`, provider failures as
`unavailable`, and unsupported families as `unsupported`. They are never
reported as zero. Portfolio history is stored profile-locally with mode `0600`
and contains public-address fingerprints and value observations, not wallet
keys or prepared transactions.

## Preparing an action

Preparation requires the real wallet that will sign. Placeholder and burn
addresses are rejected.

```js
import { data } from "@oracle-agent/oracle";

const prepared = await data.call("hl-perps", "prepareOrder", {
  /* exact market, side, size, limits, and owner wallet */
});
```

Review the chain, destination, calldata or typed data, amount, minimum output,
expiry, approvals, and fees in the user's wallet. Oracle's public package stops
before signing. Report success only after a real transaction hash, successful
receipt, and expected balance or state change.

## Locals Only fee waiver

Oracle access is public. A Locals Only NFT only waives Oracle's integrator fee.
Use `oracle fees status` to check the configured wallet. See
[locals-only-fee-waiver.md](docs/locals-only-fee-waiver.md).

## Hyperliquid builder code

Eligible Hyperliquid core perpetual orders disclose a 2 bps builder fee before
wallet review; HIP-3 and HIP-4 use 1 bps. A verified Locals Only holder receives
a 0% Oracle rate. The main wallet must separately sign the revocable maximum-fee
approval; Oracle only prepares that unsigned action. See
[hyperliquid-builder-code.md](docs/hyperliquid-builder-code.md).

## Buzz integration

Oracle includes a public, unsigned Buzz HTTP contract. It does not embed the
private executor and it does not turn Buzz into a custody surface. Setup,
endpoints, and deployment status rules are documented in
[buzz-integration.md](docs/buzz-integration.md).

## Doctor output

```bash
oracle doctor --json
```

A clean standalone install can legitimately show warnings for:

- `data_server` when `oracle data serve` is not running;
- `agent_runtime` when optional Hermes is not installed;
- `hermes_lanes` before optional `oracle init --apply`.

A Node-version failure is blocking. Signing warnings are irrelevant to the
public package because signing is not installed there.

## Upgrade

```bash
npm i -g @oracle-agent/oracle@latest
oracle --version
oracle doctor
```

Review release notes before upgrading a machine that also runs private
owner-operated infrastructure.

## Uninstall

```bash
npm rm -g @oracle-agent/oracle
```

The CLI does not silently delete local configuration or credentials. Remove
those separately only after confirming they are no longer needed.

## Build and test from source

```bash
git clone https://github.com/demi-hl/oracle.git
cd oracle
npm ci --no-audit --no-fund
npm run gate:release
npm run test:boundary
npm test
npm run typecheck
npm run build
npm run scan:secrets
```

The repository may be private or ahead of npm while a release is being staged.
The npm artifact remains the public installation source.

## Troubleshooting

### `oracle` says no provider is configured

Run `oracle auth login <provider>` or `oracle auth api-key <provider>`, then
confirm with `oracle auth status`.

### `oracle setup` says the local runtime is missing

Messaging uses optional Hermes. Run `oracle bootstrap`, then retry setup.
Standalone chat, chain selection, and public read/prepare commands do not require
Hermes.

### `oracle doctor` says the data server is down

Start it in another terminal with `oracle data serve`. Do not expose port `8787`
off-host.

### The public API or Buzz endpoint is unreachable

Start `oracle public serve --port 8799` and verify `/public/health`. Do not claim
the API is live based on the static site or source code alone.

### A prepared action cannot be signed

That is expected in the public package. Hand the reviewed artifact to a
user-controlled wallet. Do not install or request private owner infrastructure
as a workaround.

## References

- [CLI reference](docs/cli.md)
- [Public API and environment surface](docs/public-surface.md)
- [Locals Only 0% fee waiver](docs/locals-only-fee-waiver.md)
- [Buzz integration](docs/buzz-integration.md)
- [Architecture](docs/architecture.md)
- [Security policy](SECURITY.md)
