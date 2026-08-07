# Oracle

## Quickstart (standalone CLI)

```bash
npm i -g @oracle-agent/oracle@latest   # Node >= 20.19
oracle --version
oracle auth login claude               # or codex / grok
oracle                                  # native Oracle chat
oracle doctor                           # verify local posture
```

Prefer an API key instead? `oracle auth api-key openrouter` accepts hidden
interactive input. `oracle auth status` reports providers without printing
credentials. Linux, Windows, and macOS apps are in beta.


**Prepare-only multichain agent control plane.** Policy-bounded intents; your wallet signs.

Specialist agent profiles, real protocol intents, self-custody by default,
receipts or it didn't happen.

Built for [Hermes](https://github.com/NousResearch/hermes-agent), the
open-source agent runtime from [Nous Research](https://nousresearch.com), but
Hermes is optional.

Oracle can run standalone model auth directly with API keys or Claude, Codex,
and Grok OAuth. OAuth credentials use the OS keychain when available, with a
private `0600` local fallback when keychain storage is unavailable.

This package is **prepare-only**: it never takes a private key and never
broadcasts. The owner-operated signer/executor is private infrastructure, is
not published on npm, and is not part of holder onboarding. Never paste a seed,
private key, vault passphrase, or signer token into Oracle chat.

---

## Start safely

1. Install the public CLI and authenticate a model provider as shown above.
2. Run `oracle chain list`, then `oracle chain use <name>`.
3. Use reads, research, quotes, simulations, and unsigned preparation.
4. Review every prepared artifact in the wallet that will sign it.
5. Treat only a confirmed transaction hash plus receipt as execution.

Hermes is optional. To add its isolated runtime, specialist profiles, and local
read plane later:

```bash
oracle bootstrap
oracle init --apply        # writes profiles + local HMAC attestation config; no wallet key
oracle data serve          # loopback only: 127.0.0.1:8787
oracle doctor
```

Library users can prepare directly:

```js
import { data } from "@oracle-agent/oracle";
const prepared = await data.call("hl-perps", "prepareOrder", {
  /* coin, side, size, owner wallet address */
});
// Oracle stops here. The user's wallet reviews, signs, and submits.
```

See [SETUP.md](SETUP.md) for clean installation and troubleshooting,
[holder-beta.md](packages/oracle/docs/holder-beta.md) for the Locals-only launch
gate, and [buzz-integration.md](packages/oracle/docs/buzz-integration.md) for the
Buzz HTTP contract.

---

## What Oracle is

Most "AI crypto agent" projects give a model a hot wallet and hope. Oracle does
the opposite: the model *proposes*, the owner *authorizes*, and the policy layer
decides what may even be asked.

Three properties define it:

1. **Self-custody by default.** The public package never accepts your private
   key. It builds unsigned transactions and typed-data intents; your wallet
   signs them.
2. **Bound grants.** A grant is a signed, scoped, expiring permission: max
   value, chain, venue, destination allowlist, TTL. Oracle canonicalizes it,
   renders it for review, and refuses to prepare anything outside it. Runtime
   enforcement is the wallet's or smart account's job — this package never
   signs, so it cannot be the thing that stops a transaction.
3. **Receipts or it didn't happen.** A claim without a transaction hash, a
   receipt, and a balance delta is not a result.

Default posture is `DISARMED`.

## Why it's different

The differentiators are **policy, custody, and receipts** — not a smarter chat
loop.

| | Typical agent | Oracle |
|---|---|---|
| Custody | house wallet holds keys | user signs, no house custody |
| Authority | prompt-level "be careful" | signed grant: chain, spend, targets, TTL — enforced by your wallet, not by us |
| Destinations | whatever the model emits | reviewed per-chain allowlist, fail-closed |
| Slippage | fixed % | live guard recomputed per leg, hard 100 bps cap |
| Proof | model says "done" | hash + verified successful on-chain receipt + expected balance delta or it failed |
| Surface | swap only | swaps, bridges, perps, vaults, yield, NFTs, intents |

## Architecture

```
        you
         |
       Task
         |
      oracle            <- routes, never authorizes custody
         |
  +------+------+------+------+------+------+------+
  |      |      |      |      |      |      |      |
 poly   hyper  robin  solana bitcoin stable protocol
 market liquid hood                         builder
```

Each lane is a Hermes **profile**: its own system prompt, skills, memory, and
sessions. The `oracle` lane routes intent to the right specialist. Adding a lane
is adding a directory.

Three planes, and the boundary between them is mechanically enforced:

- **Data plane** (public) — read/quote across chains and protocols. No keys.
- **Policy plane** (public) — destination allowlists, slippage guards, route and
  vault attestations, grant schema. Holds no keys; constrains what a signer may
  be asked to do.
- **Exec plane** (private, optional) — signing and broadcast live only in
  separately operated owner infrastructure. It is not published on npm, not in
  this artifact, and not available to holder installs.

`test/custody-boundary.test.mjs` walks the import graph and fails if any public
module reaches wallet key material or a house signer. The split is a test, not a
promise.

## Coverage

**11 EVM chains** built in: Ethereum, Optimism, BNB, Polygon, Stable, HyperEVM,
Abstract, Robinhood Chain, Base, Arbitrum, Avalanche. Plus Solana and Bitcoin L1
lanes. Solana covers Jupiter quote/prepare, SPL account research, live
simulation of the prepared swap, and Magic Eden NFT reads with unsigned
buy/list/mint tickets. Bitcoin covers Esplora fee/UTXO reads, Ordinals/runes
research, Satflow PSBT intents, and inscription PSBT preparation. Hyperliquid
adds HyperCore HYPE staking: validator reads plus EIP-712 stake, delegate,
undelegate, and unstake preparation. User wallets sign.

**Any other EVM chain is config, not code:**

```js
import { registerCustomChain } from "@oracle-agent/oracle/scanner";

registerCustomChain({
  key: "mychain",
  chainId: 7777,
  name: "My Chain",
  rpcEnv: ["MYCHAIN_RPC_URL"],
  nativeCurrency: { symbol: "MYC", decimals: 18 },
});
```

That chain immediately has block reads, balances, on-chain token resolution, log
scanning, and structural risk checks. See
[`docs/adding-a-chain.md`](packages/oracle/docs/adding-a-chain.md).

```bash
oracle-scan chains                    # coverage matrix
oracle-scan token base 0x8335...2913  # on-chain identity
oracle-scan pools base 0x4200...0006  # pools ranked by liquidity
oracle-scan risk  base 0x8335...2913  # structural checks + sell simulation
oracle-scan sell  base 0x8335...2913  # round trip: can you actually exit?
```

**8 of 11 chains ship verified venues**: Ethereum, Optimism, BNB, Polygon, Base,
Arbitrum, Avalanche, and Robinhood Chain. They have all 10 capabilities including
live quotes, round-trip sell simulation, and unsigned swap preparation. The remaining
three (Stable, HyperEVM, Abstract) are at 7 and **fail-closed for routing value** until
someone verifies a venue: read and research work, moving money does not. That is a safe
default, not a gap.

Every venue address was verified **functionally, not by codesize** — a re-runnable
prober (`scripts/verify-v3-venues.mjs`) asks each candidate to price a pair with a
known answer. This matters: the canonical QuoterV2 address also has bytecode on
Base, but does not price that chain's pairs. A codesize check would have
allowlisted the wrong contract.

**42 provider modules** in the read/quote catalog, covering **219 unique
protocols/venues** across EVM, Solana, and Bitcoin (115 EVM + cross-chain, 98
Solana venues backed by 101 verified Jupiter program IDs, 6 Bitcoin surfaces).
One module can cover many protocols: the Jupiter module alone routes 98 Solana
venues, so provider-module count and protocol count are different numbers.

| Class | Providers |
|---|---|
| Chain / explorer | EVM JSON-RPC, Blockscout, Solana RPC, Bitcoin Esplora |
| Market data | DexScreener, GeckoTerminal, DeFiLlama |
| DEX / aggregator | Uniswap V3/V4, Aerodrome, Curve, Balancer, LI.FI, ParaSwap, Odos, 0x, 1inch, HyperEVM DEXes |
| Solana | Jupiter (98 venue labels, 101 verified program IDs) |
| Intents | CoW Protocol, RFQ |
| Perps / lending / yield | GMX v2, Morpho, Pendle |
| Bridges | Across, Hop, Relay |
| Venues | Hyperliquid (core perps + HIP-3 builder dexs + HIP-4 outcomes), Polymarket (read + local CLOB prepare) |
| NFT | OpenSea, Satflow, Magic Eden (Solana) |
| Bitcoin | mempool/Esplora, Ordinals, Runes, UniSat, Best-in-Slot, Satflow |

Every provider and every scanner capability declares an honest tier —
`read-only`, `quote-only`, `prepare`, or `intent`. **API coverage is not execution
support**, and the catalog says which is which. A chain with no verified venue is
fail-closed for routing value: read and research work, moving money does not. That
is a safe default, not a gap.

## Capability pack

Oracle's default pack is deliberately broad but disarmed:

- **Trader** — best-execution route comparison, quote/prepare, simulation, and
  receipt checks; no set-and-forget custody.
- **Builder** - chain-family fungible-token and NFT-collection launch plans,
  protocol, gacha, DEX, and launchpad scaffolds with unsigned deploy/admin actions.
  Unsupported chain adapters fail closed instead of pretending one deploy fits all.
- **Analyzer** — token, contract, venue, portfolio, market, and risk research with
  evidence labels. `/balance` or plain `balance` runs one deterministic snapshot
  across every configured EVM chain plus Solana, Bitcoin, Hyperliquid, and
  discoverable NFTs. Profile-local observations power history and SVG value graphs;
  unavailable values stay null instead of becoming fake zeroes.
- **On-chain scanner** — chain-config scanners for tokens, pools, launches,
  risk, exits, and smart-wallet boards.
- **Meme-token sniper** — fast launch/liquidity monitoring across configured
  chains, guarded by identity checks, sell-sim/reverse-route proof, caps, and
  unsigned user-wallet tickets.
- **Per-chain graphs + Telegram cards** — charted scanner alerts, route cards,
  meme-launch cards, Hyperliquid HIP-3/HIP-4 cards, and Polymarket cards. User
  API-key actions activate only when self-hosted keys are configured.
- **NFT mint gas-war limits** — public mint bots enforce chain-bound gas caps,
  per-unit fee caps, and optional priority-fee caps before returning unsigned
  mint transactions. Import `validateNftMintGasWar` from the package root or
  `@oracle-agent/oracle/nft-gas-war`.
- **Cross-chain RFQ + tokenized assets** — RFQ/intent venues are compared across
  supported chains where configured, and tokenized Robinhood-style assets can be
  bought only after exact contract, venue, route, and sellability checks.
- **Solana** — SPL accounts, Jupiter quotes, unsigned swap transactions, and
  simulation.
- **Bitcoin** — L1 reads, Ordinals/runes, Satflow PSBT intents, and inscription
  PSBT preparation.

Every money-moving path stays prepare/simulate first. Signing and broadcast are
wallet/grant actions, not model authority. Meme-token sniping defaults to fast
scan + prepared ticket; blind broadcast requires a separate capped local signer
loop and explicit opt-in. NFT mint bots must also honor gas-war caps before any
wallet-signable transaction is returned. RFQ and tokenized-asset routes are
capability-labeled per chain; unconfigured venues stay unavailable instead of faked.

## Install

```bash
npm install @oracle-agent/oracle    # Node >= 20.19.0
```

Or from source, if you want to run the suite:

```bash
git clone https://github.com/demi-hl/oracle.git
cd oracle
npm install
npm test
```

**→ [SETUP.md](./SETUP.md) covers public data credentials and the separate
owner-local source lane.** The short version:

- Reads and quotes need **no keys**.
- The public package exposes no signer, key vault, or broadcast path.
- User wallets authorize prepared actions outside the public data plane.
- Owner-local signing exists only in separately operated private infrastructure;
  it is not published on npm and is not a holder capability. When installed by
  the owner, its generic signer exposes six policy-bounded surfaces: `hl`,
  `poly`, `evm-swap`, `evm-bridge`, `btc`, and `sol`, with explicit caps and
  fail-closed allowlists.

### Action vocabulary and execution planes

Oracle keeps capability and authorization separate:

- Public Oracle reads, quotes, simulates, and prepares unsigned artifacts.
- **Path A:** owner/main, browser, smart-account, hardware, or protocol-native
  wallets sign the prepared artifact. This is the default self-custody path.
- **Path B:** private owner-local infrastructure may sign on the same host with
  the owner's key and policy. It is deployment-specific, unavailable to holder
  installs, and must never expose a vault passphrase or signer credential to the
  agent process.
- The generic unattended signer exposes six bounded surfaces: `hl`, `poly`,
  `evm-swap`, `evm-bridge`, `btc`, `sol`. Each surface decodes its own
  envelope, enforces its caps, and refuses while its allowlists are empty.
- Ordinary EVM preparation remains user-wallet signed unless a trusted
  owner-controlled direct-exec process is explicitly installed and armed.
- `ORACLE_AUTONOMOUS_TRADING=1` is direct execution for trusted owner-controlled
  local code only. It is never model/agent authority and should not be framed as
  equivalent to the `oracle-signer` agent-process path.
- A deployment may separately install a same-host, owner-gated EVM executor.
  Oracle must verify that executor before describing bounded EVM execution as
  available. Missing deployment capability means "unavailable here," not
  "Oracle can never execute EVM."
- `watch`, `watch this`, and `ping me` always create `active: true, actionMode: alert_only`.
- `arm` creates `active: true, actionMode: execute` only for one exact owner-authorized action. It is never inferred from a watch.

The package exports this binding as `@oracle-agent/oracle/action-semantics`. Legacy watch stores can migrate `status: watching|armed` with `migrateLegacyWatchRecord()`; because it is specifically a watch-store migration, both statuses become `alert_only`, never execution authority.

Run the read-only data plane:

```bash
npm run start:data
npm run health
```

Run the public console (wallet connect, grant editor, receipts):

```bash
npm run start:public
# http://127.0.0.1:8799/
```

This is an unauthenticated loopback development server, not a holder gate or a
public deployment. Keep it off LAN/tailnet/public interfaces and place a tested
admission gateway in front of any hosted beta.

## Model providers

Oracle is a library. Drive it with Claude, GPT, Gemini, Grok, a local model, or
a plain script — the tools are ordinary functions plus an MCP server:

```bash
npx oracle-data         # local read plane on 127.0.0.1:8787
npx oracle-data-mcp     # MCP stdio server (any MCP client); needs oracle-data up
```

It is better under [Hermes](https://hermes-agent.nousresearch.com/docs), because
a trading stack is several workloads with opposite needs and **per-profile
routing** gives each its own model, tools, and key scope: cheap wide context for
research, a fast model for execution where latency is money, the strongest model
for risk review, something small for unattended crons. The research profile can
hold no signing key at all.

Oracle's own pre-release audit ran four model lineages — Grok 4.5, Opus 5,
Fable 5, GPT-5.6 — and **each found a critical bug the others missed**. One
model reviewing its own work would have shipped three of them.


## Agent profiles

Oracle ships an installable 8-lane mesh for Hermes:

```bash
oracle-init            # dry run -- shows exactly what it would do
oracle-init --apply    # create profiles, install SOULs + skills, wire MCP config
npx oracle-data        # keep running — MCP tools call the local read plane on :8787
oracle                 # premium boxed TTY on the same oracle profile as messaging
oracle model           # choose provider/model; persona stays oracle
oracle chain use hyperliquid
oracle setup           # telegram / discord / slack messaging
```

Terminal and configured messaging channels are transports into the same Hermes
`oracle` profile. When a local operator/MCP is configured, an explicit owner
trade instruction can execute from either interface. The selected model never
bypasses signer-owned grants, allowlists, caps, MAC checks, simulation, or
receipt verification.

Lanes: `oracle` (router), `polymarket-agent`, `hyperliquid-agent`,
`robinhood-agent`, `solana-agent`, `bitcoin-agent`, `stable-agent`,
`protocol-builder`, plus `_template` for your own. Details in
[`docs/profiles.md`](packages/oracle/docs/profiles.md).

Every lane installs **DISARMED**. No lane requests a broadcast or signing action —
only read, simulate, and prepare — and a test enforces that so widening custody
can't pass review quietly. An existing `SOUL.md` is never overwritten without
`--force`, and `--force` writes a timestamped backup first.

Oracle does not issue its own model credential. Standalone chat uses the OAuth
login or API key the user configured; Hermes mode uses whichever provider that
Hermes installation already supports.

**Why "built for Hermes" and not just "works anywhere":** Oracle's read plane is
an MCP server, so any MCP client can call it. But the *mesh* — per-lane memory,
skills, sessions, and separate model choice per specialist — is Hermes profile
machinery. You can use Oracle from any agent; you get the architecture in the
diagram above from Hermes.

## Best-execution routing

The highest quote is not the cheapest swap. Oracle ranks on **net received after
gas and fees**, comparing every available source in parallel:

```bash
oracle-route swap   base 0x4200...0006 0x8335...2913   # WETH -> USDC
oracle-route bridge arbitrum base                       # ETH across chains
```

```
  source           net out           gross  cost
* paraswap    1,903.880867    1,903.893053  $0.01
  cow         1,903.693798    1,903.693798  gasless (solver)
  lifi        1,894.432632     1,899.20966  $4.78
```

Sources: **LI.FI, CoW, ParaSwap, 0x, 1inch** for swaps · **LI.FI, Relay, Across**
for bridges. 0x and 1inch activate when their API key is present; the rest need
none.

Why net matters:

- **Gas is part of the price.** A route quoting 0.2% more but costing $14 more in
  gas loses on a $500 swap and wins on a $50k one. The crossover depends on trade
  size, so any fixed preference is wrong on one side of it.
- **Intents can beat AMMs.** CoW's solver pays the gas, so a slightly lower gross
  quote often wins on net — the case naive ranking always gets backwards.
- **Sources disagree about what they mean.** Some report gas in USD, some in native
  wei, some not at all. Oracle normalizes, and marks what was measured.

**Unknown cost is never scored as zero.** A source that does not report gas is
ranked on gross and flagged, because scoring an unknown as free is how the worst
route wins a comparison. When the top two routes measure cost differently, Oracle
quotes **no spread at all** rather than a number that compares different things.

Then prepare the winner in one step:

```bash
oracle-route prepare base <tokenIn> <tokenOut> <yourWallet>
```

You get back an **unsigned transaction** (LI.FI, ParaSwap, 0x) or **EIP-712 typed
data** for an off-chain order (CoW). `artifactKind` says which — they need different
wallet actions, and one is not broadcast at all. Prepare **re-quotes** and reports
`driftBps` against the comparison, because a minimum computed from a stale quote is
not a minimum.

Bridges prepare too:

```bash
oracle-route prepare-bridge arbitrum base <yourWallet>
```

Bridge artifacts are always a **list** of transactions — some routes need an approval
and a deposit signed in order, and signing only the first leaves funds approved but
not bridged. Both chains are reported, and a transaction whose chain does not match
the origin is refused. Oracle states plainly that **bridging is not atomic**: the
origin transaction confirming does not mean funds arrived.

Routing never signs. `taker` must be the real wallet; placeholder addresses are
rejected, since quoting is anonymous but preparing is not. Signing happens in
the user's wallet or in a separately operated source-only execution lane.

Individual source failures degrade the comparison by one source instead of breaking
it — verified in practice when Odos sunset their public API mid-development
(HTTP 410); the router kept ranking and the provider was marked `unavailable`.

## Examples

```bash
node examples/add-a-chain.mjs             # register an unseen chain, no code
node examples/research-a-token.mjs        # honest token research on live data
node examples/oracle-pack-template.mjs    # skeleton for a safe Oracle protocol pack
```

## MCP

Oracle exposes its read plane over the Model Context Protocol, so any MCP client
(Hermes, Claude Code, others) can use it:

```bash
oracle-data-mcp
```

## Security

- Oracle never receives private keys.
- The router can propose, simulate, explain, and draft. It cannot authorize.
- Public modules may not import signer or executor code (enforced by test).
- Destination allowlists are per-chain and fail-closed: an empty allowlist
  refuses everything rather than allowing everything.
- Report vulnerabilities per [SECURITY.md](SECURITY.md). Please do not open a
  public issue for a live exploit.

## What Oracle is not

- Not an autonomous trader. There is no "set and forget."
- Not custodial. If a design needs your key on our server, that design is wrong.
- Not a guarantee. Crypto execution carries real risk; read the code you run.

## License

[Business Source License 1.1](LICENSE) — source-available, not open source.

You may read, modify, self-host, and use Oracle freely for internal use,
evaluation, research, and personal use. What you may not do is offer Oracle,
or substantially its functionality, to third parties as a competing product
or hosted service without a commercial license.

Each version converts to **Apache-2.0** on its Change Date (four years after
release). Versions `0.1.0` through `0.11.0` were published under Apache-2.0
and remain under those terms.

The **Oracle** name and marks are reserved; please don't imply endorsement by
an official deployment when shipping a fork.

For commercial licensing, contact the maintainer.
