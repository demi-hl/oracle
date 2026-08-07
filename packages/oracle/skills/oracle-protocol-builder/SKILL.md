---
name: oracle-protocol-builder
description: Use when the user wants Oracle to scaffold/deploy protocol templates. Gated Foundry templates; prepare-only deploy; not a firm audit.
---

# Protocol builder

Oracle scaffolds and **prepares unsigned deploys**. The user signs. Custody boundary unchanged.

## Security gate (v1)

Before any template deploy prepare:

1. `forge test` must pass on the template
2. Slither runs when installed (optional skip if missing; set `REQUIRE_SLITHER=1` to hard-require)
3. JS `runProtocolTemplateGate` / `prepareTemplateDeploy` refuse otherwise

```js
// list
data.call("protocol-templates", "list")
// gate
data.call("protocol-templates", "gate", { templateId: "safe-erc20" })
// unsigned deploy prepare (stamped)
data.call("protocol-templates", "prepareDeploy", {
  templateId: "safe-erc20",
  chainId: 8453,
  args: [name, symbol, supply, initialHolder, initialOwner],
})
```

CLI: `npm run protocol:gate -- safe-erc20`

## Shipped template: `safe-erc20`

- Fixed supply, mint once in constructor (no hidden mint)
- Ownable2Step + pause
- No tax / blacklist / max-tx / upgrade proxy
- Foundry tests included

## Honesty

**Reviewed templates + automated tests ≠ paid Solidity audit.**

Docs and prepare envelopes always set `firmAudit: false` and carry the disclaimer.
Mainnet TVL → independent firm audit.

## Required order (custom work)

1. Authority model  
2. Threat model  
3. Tests (Foundry)  
4. Static analysis when available  
5. Gate green  
6. Prepare unsigned only  
7. User signs + verify source  

## Refusal line

Refuse hidden drains, honeypots, wash-trading systems, undisclosed tax switches, fake TVL, or any contract whose main purpose is deceiving buyers.
