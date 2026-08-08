# Public surface

Every supported import subpath, executable, and runtime environment variable in
`@oracle-agent/oracle`. If something is in `exports`/`bin` it is a public
contract and belongs here; if it is not meant to be public it should be removed
from the manifest rather than left undocumented.

Generated counts are asserted by `test/public-surface-doc.test.mjs`, so this
file cannot silently drift from `package.json`.

## Import subpaths

| Subpath | What it gives you |
|---|---|
| `@oracle-agent/oracle` | package root — re-exports the common surface |
| `@oracle-agent/oracle/data` | provider catalog + `dataCall` read plane |
| `@oracle-agent/oracle/policy` | grant policy schema: validation, canonicalization, caps constants |
| `@oracle-agent/oracle/chains` | chain registry and per-chain metadata |
| `@oracle-agent/oracle/scanner` | token/contract scanner capabilities |
| `@oracle-agent/oracle/router` | route sources and quote routing |
| `@oracle-agent/oracle/equities` | cross-chain on-chain equities best execution (HIP-3 / Arcus / RH / Solana / TON), prepare-only |
| `@oracle-agent/oracle/strategy` | deterministic Hyperliquid strategy drafting, validation, simulation, evidence, shadowing, and unsigned prepare-only handoff |
| `@oracle-agent/oracle/action-semantics` | decoded-action semantics for review |
| `@oracle-agent/oracle/address-book` | label store — refuses key material |
| `@oracle-agent/oracle/agent-grants` | bounded, revocable, time-boxed agent permissions: `planConnection` builds the unsigned grant, `activateSession` accepts the owner's signature, `revokeSession` revokes, and `listActiveGrants`/`getGrant`/`classifyGrant` read it back. Reads are pure over an injected store with an explicit clock. Oracle prepares and validates; the user signs and Oracle never holds a key |
| `@oracle-agent/oracle/names` | cross-chain name resolution: `.hl` (HLNames), `.hype` (dotHYPE), `.eth` (ENS), Basenames. Forward and reverse, keyless on-chain reads via the read-only RPC allowlist; never signs or broadcasts |
| `@oracle-agent/oracle/nft-gas-war` | NFT mint/gas-war helpers |
| `@oracle-agent/oracle/prepare-envelope` | `stampPrepared` / `assertPreparedEnvelope` |
| `@oracle-agent/oracle/connect` | deterministic MCP harness configuration snippets for Hermes, Claude Code, Codex, Cursor, and generic clients |
| `@oracle-agent/oracle/receipts` | caller-fact action-receipt normalization — refuses secret-bearing fields; does not verify chain success |
| `@oracle-agent/oracle/risk` | risk scoring helpers |
| `@oracle-agent/oracle/watch` | watch/alert subscriptions |
| `@oracle-agent/oracle/signals` | signal feed helpers |
| `@oracle-agent/oracle/farming` | farming method presets, live farm scoring (`discoverFarms`), and airdrop expected-value math (`airdropEV`) — read-only discovery and prepare-plan design; never signs or broadcasts |

`./package.json` is deliberately **not** exported. Do not derive internal paths
with `require.resolve('@oracle-agent/oracle/package.json')` — it throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`. Invoke the shipped bins by name instead.

## Executables

| Bin | Purpose |
|---|---|
| `oracle` | main CLI |
| `oracle-data` | local read-plane server (`oracle data serve`) |
| `oracle-public` | public-plane server (`oracle public serve`) |
| `oracle-data-mcp` | MCP stdio server for agent lanes |
| `oracle-init` | write config + attestation secret (`oracle init --apply`) |
| `oracle-upgrade` | in-place upgrade helper (`oracle upgrade`) |
| `oracle-scan` | scanner entrypoint |
| `oracle-route` | route/quote entrypoint |
| `oracle-equities` | on-chain equities best execution (HIP-3 / Arcus / RH / Solana / TON) |

## Environment variables

### Arming flags — default OFF, enable only on literal `1`

These are the gates that decide whether anything can ever be signed or
broadcast. `envFlag` is strict: `true`, `yes`, `on`, or any other value leaves
them OFF. Setting them is not sufficient to move funds — the signer's own
policy and custody wall still apply.

| Name | Default | Meaning |
|---|---|---|
| `ORACLE_EXECUTE_ENABLED` | off | allow the signing surface to arm at all |
| `ORACLE_DEPLOY_ENABLED` | off | allow contract deployment paths to arm |
| `ORACLE_ONBOARD_HTTP` | off | expose onboarding routes over HTTP |
| `ORACLE_PUBLIC_API_MODE` | off | run the server in public-plane mode |
| `ORACLE_ALLOW_CREATE` | off | allow create/deploy-shaped actions |
| `ORACLE_ALLOW_EPHEMERAL_CAPS` | off | allow ephemeral cap grants |

### Guard rails — default ON, honor disable words

| Name | Default | Meaning |
|---|---|---|
| `ORACLE_VALUE_CAPS_ENABLED` | on | per-transaction value caps. Uses strict `!== "0"` so a stray `false` leaves the cap wall standing |

### Integrity and attestation

| Name | Meaning |
|---|---|
| `ORACLE_ROUTE_ATTESTATION_SECRET` | keyed route attestation HMAC. Written by `oracle init --apply` |
| `MAD_ROUTE_ATTESTATION_SECRET` | legacy alias for the above |
| `ORACLE_ATTESTATION_SECRET` | alternate attestation secret name |
| `ORACLE_STAMP_HMAC_SECRET` | keyed MAC over prepared envelopes. A verifier holding this secret **requires** a valid MAC — an envelope with the MAC stripped is refused, so the keyed mode cannot be silently downgraded to the unkeyed checksum |
| `ORACLE_STAMP_REQUIRE_MAC` | set `1` to require a MAC even when the verifier has no secret configured. With a secret set this is already implied |
| `ORACLE_PREPARE_HARD_MAX_AGE_MS` | hard ceiling on prepared-envelope age |

### Servers and endpoints

| Name | Default | Meaning |
|---|---|---|
| `ORACLE_INTEGRATOR_FEE_BPS` | unset (5 bps when recipient is set) | Integrator fee in basis points on routed swaps, clamped to 100 (1%). A valid recipient opts in and an unset value defaults to 5 bps. Without a recipient, or when explicitly zero, negative, or malformed, no fee applies. A verified Locals Only holder receives a 0% Oracle rate; ownership never changes product access |
| `ORACLE_INTEGRATOR_FEE_RECIPIENT` | unset | EVM address that receives the fee. **Required**: a fee configured without a valid recipient fails closed to no fee, because otherwise the basis points are charged and silently kept by the aggregator |
| `ORACLE_INTEGRATOR_ID` | `oracle` | Integrator/partner string sent to route providers. ParaSwap accepts any value with no registration; LI.FI requires the id to be registered at portal.li.fi or the quote 400s |
| `ORACLE_HL_BUILDER_ADDRESS` | unset | Operator-configured Hyperliquid builder address. It is never published by Oracle |
| `ORACLE_HL_BUILDER_FEE_BPS` | category default | Core perpetual builder fee. Defaults to 2 bps and may only be lowered |
| `ORACLE_HL_BUILDER_SPOT_FEE_BPS` | category default | Spot builder-fee policy. Defaults to 1 bps and may only be lowered; spot order preparation is not active |
| `ORACLE_HL_BUILDER_HIP3_FEE_BPS` | category default | HIP-3 builder fee. Defaults to 1 bps and may only be lowered |
| `ORACLE_HL_BUILDER_HIP4_FEE_BPS` | category default | HIP-4 builder fee. Defaults to 1 bps and may only be lowered |
| `ORACLE_DATA_HOST` | `127.0.0.1` | read-plane bind host (loopback enforced) |
| `ORACLE_DATA_PORT` | `8787` | read-plane port |
| `ORACLE_DATA_URL` | `http://127.0.0.1:8787` | where the CLI looks for the data server |
| `ORACLE_PUBLIC_HOST` | `127.0.0.1` | public-plane bind host (loopback enforced) |
| `ORACLE_PUBLIC_PORT` | — | public-plane port |
| `ORACLE_TRUST_PROXY` | unset (off) | when `1`, read the caller IP from `X-Forwarded-For` for rate limiting. Set this ONLY when the service sits behind a proxy you control that overwrites the header. Enabling it on a directly-exposed server lets any client spoof a fresh identity per request and bypass the rate limit entirely. |
| `ORACLE_INDEXER_RPC_<CHAINID>` | unset | optional `eth_getLogs`-capable endpoint for one chain, e.g. `ORACLE_INDEXER_RPC_1`. Enables full approval discovery on that chain instead of the curated candidate probe. |
| `ORACLE_INDEXER_RPC_DEFAULT` | unset | fallback indexer endpoint for chains without a specific override. |
| `ORACLE_INDEXER_CHUNK_SPAN` | `10000` | max block span per `eth_getLogs` query. Many endpoints refuse wider ranges; lower it if yours caps harder. |

### Approval discovery coverage

Without an indexer endpoint, approval scanning probes a curated set of known
routers and tokens with `allowance()`. That works on any public RPC but is
scoped: an approval to a spender outside the list is not found, so an empty
result means "nothing found in that scope", never "this wallet is safe". The UI
states the scope rather than implying safety.

Configuring `ORACLE_INDEXER_RPC_*` upgrades discovery to log-derived, covering
all tokens and spenders. Liveness is still confirmed by re-reading
`allowance()` / `isApprovedForAll()`, because log state alone reports
long-revoked approvals as active.

### Rate limiting and admission

#### `0.12.0` clock migration

`buildConnectRequest`, `assembleUnsignedGrant`, and `planConnection` now require
`opts.now` even when the input already supplies an absolute `expiresAt`. Callers
migrating from `0.11.x` must pass a positive unix-seconds integer. This is an
intentional fail-closed API change: live construction no longer silently falls
back to shape-only validation. Hosted HTTP callers should not send a security
clock; the server replaces caller time with its own clock.

Live grants have a hard maximum TTL of 24 hours. Direct library calls to
`buildConnectRequest` and `assembleUnsignedGrant` require an explicit
`opts.now` so deterministic tests and offline clients cannot fall back to an
implicit clock. At the HTTP boundary, caller-provided `opts.now` is ignored:
the server clock is authoritative for connect, assemble, active-list, and
grant-status routes. Caller-provided `allowWildcardActions` is also ignored;
hosted grant routes always reject wildcard scope. Shape-only normalization
without `now` is reserved for historical identification/indexing and does not
establish live authority.

The public plane is unauthenticated, so both planes are throttled per caller IP
in fixed 60-second windows: 120 requests for cheap reads, and 10 for
`/public/approvals`, which fans a single request out to many upstream RPC calls.
A throttled caller gets `429` with `Retry-After` before any request body is
parsed. `chainIds` is additionally capped at 12 per request so one call cannot
cost as much as many.

This limiter is an abuse brake, not authentication. Keep the server on loopback;
a hosted service requires server-side authentication and per-user isolation.
Buzz discovery, capability verification, and audit routes are documented in
[buzz-integration.md](buzz-integration.md).

Counters are in memory and reset on restart. That is sufficient for accidental
hammering and casual abuse; a distributed flood still needs an edge/WAF in
front.

The data server serves `/health`; `/` intentionally returns 404 with a route
list.

### Paths and config

| Name | Meaning |
|---|---|
| `ORACLE_CONFIG_DIR` | config directory (default `~/.config/oracle`) |
| `ORACLE_EXEC_ENV_FILE` | path to `exec.env` |
| `ORACLE_AGENT_KEYS_PATH` | agent key store path |
| `ORACLE_AUTH_FILE_STORE` | auth file store path |
| `ORACLE_ADDRESS_BOOK` | address-book path |
| `ORACLE_OPERATOR_BIN_DIR` | operator binary directory |
| `ORACLE_AUDIT_STREAM` | audit stream destination |

### Packaged desktop mode

The desktop app sets these itself. They are documented because they change
security-relevant behavior, and an operator should be able to find out exactly
what the bundled app does differently from a plain `npm i -g` install.

| Name | Default | Meaning |
|---|---|---|
| `ORACLE_PUBLIC_DESKTOP` | off | Marks the process as the packaged public desktop. While on: the sign-plane operator is never resolved even if one is installed on the host, remote compute backends are refused, and legacy `~/.config/mad-desk` fallbacks resolve to the app-owned config dir instead of the host's. |
| `ORACLE_REMOTE_COMPUTE_DISABLE` | off | Refuses any remote/SSH chat compute backend regardless of stored config. |

### Routing and defaults

| Name | Meaning |
|---|---|
| `ORACLE_ALLOWED_CHAINS` | restrict routing to a chain allowlist |
| `ORACLE_DEFAULT_ADDRESS` | default address for reads |
| `ORACLE_PROFILE` | active profile name |
| `ORACLE_PRIVY_APP_ID` | Privy app id for connect flows |

### Runtime integration

| Name | Meaning |
|---|---|
| `ORACLE_HERMES_BIN` | path to the agent runtime binary |
| `ORACLE_CLAUDE_CODE_VERSION` | pinned agent runtime version |
| `ORACLE_PYTHON` / `ORACLE_UV_BIN` | interpreter overrides |
| `ORACLE_NATIVE_TUI` / `ORACLE_FORCE_CHAT` / `ORACLE_PLAIN_HARNESS` | CLI presentation modes |
| `ORACLE_NO_BOOTSTRAP` | skip bootstrap on start |
| `ORACLE_CLI_DEBUG` | verbose CLI diagnostics |

### Test-only

| Name | Meaning |
|---|---|
| `ORACLE_TEST_ISOLATE_SECRETS` | isolate secrets during tests |
| `ORACLE_FAKE_HOME` | redirect `$HOME` during tests |
