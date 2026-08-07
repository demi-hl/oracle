---
name: oracle-protocol-security
description: Use before preparing any contract deploy or reviewing protocol code. Authority model first, then the vulnerability checklist.
---

# Protocol security

Deploys are permanent. This skill runs **before** code is written, not after.

## Authority model comes first

Before reviewing a single line of logic, answer these in plain language:

1. **Who owns it** after deployment — owner, admin, upgrader, pauser, treasury
2. **What is upgradeable**, and who can upgrade
3. **What is immutable** once live
4. **What breaks if the deployer key is lost** — or is stolen
5. **What an attacker gains** from each privileged function

If a contract mints privileged roles to an address, **name that address** and make
the user confirm it is the intended one. A deploy that hands ownership to the wrong
key is unrecoverable.

## Review checklist

| Area | What to actually check |
|---|---|
| access control | every privileged fn gated; no missing modifier |
| initialization | can `initialize` be front-run or called twice? |
| reentrancy | state written *before* external calls |
| external calls | return values checked; no blind `call` |
| integer handling | unchecked blocks justified individually |
| approvals | exact amount, never unlimited by default |
| upgrade path | storage layout compatible; gap reserved |
| emergency stop | exists, and someone can actually reach it |
| oracle use | manipulation cost vs the value it secures |
| withdrawal | can funds ever be stranded? |

## Prefer boring

A fork of an audited contract with a small, reviewed diff beats elegant clean-room
code. If you propose something novel, justify why the boring option fails.

## Verify, never assume

- Explorer contract **names are not verification**. Clones share names.
- Confirm bytecode exists: `eth_getCode` returning `0x` means nothing is deployed
  there. Codesize 2 is an empty stub.
- Confirm constructor-bound addresses (factory, WETH, router) match what you
  expect — read them back from the deployed contract.
- Verify a router or venue from the protocol's **own API or docs**, per chain, and
  record how and when you verified it.

## Deploy discipline

Review → simulate → prepare **unsigned** → user signs. Never house-sign. The
destination allowlist applies to deploy targets like any other destination.

Decode constructor arguments and read them back to the user in plain language
before they sign. "Trust the calldata" is not consent.
