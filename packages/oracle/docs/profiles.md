# Agent profiles

Oracle is not one agent. It's a mesh of specialists with a router in front.

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

Each lane is a [Hermes](https://github.com/NousResearch/hermes-agent) **profile**:
its own system prompt, skill set, memory, and session store. They share a wallet
policy and a receipts discipline, nothing else.

## Why profiles instead of one big agent

Three practical reasons, learned the hard way:

1. **Context stays small.** A Polymarket question shouldn't load Bitcoin
   ordinals knowledge. Smaller context is cheaper, faster, and more accurate.
2. **Memory doesn't cross-contaminate.** What the perps lane learned about
   funding rates should not leak into the NFT lane's judgment.
3. **Blast radius is bounded.** A grant scoped to one lane's venues can't be
   spent by another.

## The lanes

| Profile | Owns | Typical grant |
|---|---|---|
| `oracle` | routing, synthesis, multi-chain comparison, `/balance` portfolio aggregation | read + simulate only |
| `polymarket-agent` | prediction markets, event odds, CLOB cards/API-key order intents | read, quote, prepare |
| `hyperliquid-agent` | perps, spot, HIP-3 builder dexs, HIP-4 outcomes | read, quote, prepare |
| `robinhood-agent` | Robinhood Chain (4663) tokens, NFTs, tokenized Robinhood-style assets, capped NFT mints | read, quote, prepare |
| `solana-agent` | Solana swaps, research, Jupiter routes | read, quote, prepare |
| `bitcoin-agent` | Bitcoin L1, Ordinals/runes, inscriptions | read, prepare:inscription |
| `stable-agent` | Stable (988), USDT-native gas quirks | read, quote, prepare |
| `protocol-builder` | scaffold, review, prepare chain-family token/NFT collections, gacha, DEX, and protocol deploys | prepare:deploy, prepare:mint, simulate |
| `_template` | your new lane | you decide |

These grants describe the public prepare plane, not every capability an operator may install beside it. The generic unattended signer exposes six bounded surfaces (`hl`, `poly`, `evm-swap`, `evm-bridge`, `btc`, `sol`), each of which decodes its own envelope and refuses while its allowlists are empty. A separately installed, same-host, owner-gated EVM executor may expose one exact bounded action after explicit `arm`; profiles must verify it before claiming availability. `watch`, `watch this`, and `ping me` remain `alert_only` regardless of executor presence.

`protocol-builder` classifies each launch by chain family, then designs and
prepares unsigned token, NFT collection, protocol, or mint-bot transactions. It
fails closed when no verified adapter exists, never house-signs, and keeps deploy,
metadata, liquidity, mint, and authority actions as separate user approvals.

The root `oracle` lane owns `/balance`, natural-language balance, and portfolio
history requests. Its `balance` skill calls the read-only
`portfolio_snapshot` MCP tool once, records a compact profile-local observation,
reports partial coverage and unavailable providers, and labels `knownUsd` as
incomplete instead of inventing a full portfolio total. `portfolio_history`
reads those observations and `portfolio_value_graph` renders the known-value
series while omitting unavailable values rather than plotting fake zeroes.

## Model choice is yours

Oracle makes **no model calls**. It has no LLM client, no API key, no inference
dependency — its runtime deps are `ethers`, `viem`, and three `@noble`/`@scure`
crypto libraries. Every lane inherits whatever provider your Hermes is configured
with.

So there is nothing to sign up for. If Hermes already talks to a model, Oracle
works.

What profiles *do* give you is **per-lane** model choice, because each profile has
its own `config.yaml`:

```yaml
# ~/.hermes/profiles/<name>/config.yaml
model:
  provider: anthropic        # or openai-codex, nous, xai-oauth, a local model...
  default: claude-opus-5
```

That lets you put a heavy reasoner on the router and something cheap and fast on
a polling lane:

| Lane | Wants | Why |
|---|---|---|
| `oracle` | strongest reasoner | routing and synthesis need judgment |
| `protocol-builder` | strongest reasoner | contract review is unforgiving |
| `hyperliquid-agent` | fast, numeric, tool-heavy | many small tool calls |
| `polymarket-agent` | news-shaped reasoning | event pricing is narrative |
| research fan-out | cheap and parallel | breadth over depth |

Starting point, not doctrine. Benchmark on your own workload.

### If you want one login for many models

Optional convenience, not a requirement: [Nous
Portal](https://nousresearch.com) fronts the frontier set (Claude, GPT, Grok,
DeepSeek, Qwen and more) behind a single Hermes credential, so each lane can pick
a different model without five separate API keys and five bills.

```bash
hermes auth add nous
```

Any Hermes-supported provider works equally well. Oracle does not care.

## Creating a lane

```bash
hermes profile create polymarket-agent
```

Then give it a `SOUL.md` (who it is, what it owns, what it must refuse) and a
`config.yaml` (model + provider). Point it at Oracle's MCP read plane.

`oracle-init --apply` writes this for you. Manual form (Hermes wants command and
args as separate tokens):

```bash
# terminal 1 — local read plane the MCP tools call
npx oracle-data

# terminal 2 — wire MCP into a lane
hermes -p polymarket-agent mcp add oracle-data --command oracle-data-mcp
```

Now that lane can read 42 provider modules covering 219 protocols/venues across
EVM, Solana, and Bitcoin, quote real routes, and
prepare unsigned transactions — and it still cannot sign anything.

## Posture

Every lane starts `DISARMED`. Arming is a deliberate, scoped, expiring act:

```
grant:
  chain: 8453
  actions: [read:chain, simulate:tx, prepare:swap]
  targets: [<router address>]
  maxValueWei: <cap>
  expiresAt: <unix ts>
```

An action outside the grant is refused, not negotiated. When the grant expires,
the lane goes back to reading.

## A rule worth keeping

Give a lane the narrowest grant that makes it useful, and let it expire. A
permanent broad grant is just a hot wallet with extra steps.
