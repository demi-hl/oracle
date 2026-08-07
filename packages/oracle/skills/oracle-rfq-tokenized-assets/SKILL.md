---
name: oracle-rfq-tokenized-assets
description: RFQ/intent routing across supported chains and guarded buys for tokenized Robinhood assets when user keys/routes are configured.
---

# Oracle RFQ + tokenized asset routing

Use when a user asks for RFQ, solver/intent quotes, request-for-quote execution,
or buying tokenized Robinhood-style assets/stocks on supported chains.

## RFQ scope

Oracle should treat RFQ as another best-execution source, not a bypass:

- Query RFQ/intent venues where the chain and token pair are supported and the
  user has configured any required API keys.
- Compare RFQ quotes against AMM/aggregator routes on net received after gas,
  fees, solver spread, and settlement assumptions.
- Return `artifactKind` precisely: signed typed-data order vs unsigned tx vs
  wallet-provider action.
- Re-quote immediately before prepare/signing. RFQ expiry/nonce is short-lived.
- Do not fabricate RFQ support for a chain without a configured venue.

## Every-chain rule

"Across all chains" means every configured chain is attempted and capability-labeled:

- `RFQ_READY`: venue configured, quote live, prepare path verified.
- `QUOTE_ONLY`: quote available, but no reviewed prepare path.
- `UNCONFIGURED`: needs user API key or venue credentials.
- `UNAVAILABLE`: no RFQ venue for that chain/token pair.
- `BLOCKED`: policy, unsupported asset, compliance, or route guard rejected.

Unsupported is an honest result, not a failure to hide.

## Tokenized Robinhood assets

Treat tokenized Robinhood assets as normal on-chain assets plus extra identity/risk
checks:

1. Resolve the exact chain and contract/mint from the official issuer/venue or a
   user-provided contract. Never infer from ticker alone.
2. Check asset metadata, decimals, supply, issuer/proxy/admin controls, transfer
   restrictions, and redeemability/custody disclosures when public.
3. Verify the venue/router can quote and prepare the asset on that chain.
4. For buys, run the same route and slippage guard as any ERC-20/SPL swap.
5. For sells, run sellability/reverse route first; tokenized assets may trade like
   wrappers and can have restricted-transfer or allowlist rules.
6. User signs; Oracle does not custody or guarantee redemption.

## Output contract

Return a table per chain/venue:

- chain / venue / asset id
- RFQ status and expiry
- gross quote, estimated gas/fees, net output
- artifact kind and signing path
- policy blockers
- confidence and data timestamp

## Pitfalls

- Calling a solver/RFQ quote "gasless" when the cost is hidden in spread.
- Using an RFQ quote after expiry.
- Treating a tokenized stock ticker as identity without contract provenance.
- Ignoring transfer restrictions that make buys possible but exits blocked.
- Routing tokenized Robinhood assets through DEMI/RH private executor by default;
  public users must use their own wallet/key/API setup.
