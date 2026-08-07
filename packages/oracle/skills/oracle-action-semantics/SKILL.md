---
name: oracle-action-semantics
description: Use for watch, ping, prepare, arm, sign, send, or execution-capability questions.
---

# Oracle action semantics

Keep these planes distinct:

1. **Public prepare plane**: reads, quotes, simulates, and prepares unsigned artifacts. It never signs or broadcasts.
2. **Generic Oracle signer**: the unattended daemon exposes six *bounded* surfaces — `hl`, `poly`, `evm-swap`, `evm-bridge`, `btc`, `sol`. Bounded is not generic chain authority: each surface decodes and validates its own envelope shape and refuses while its allowlists are empty. Enablement is never authority; every signature still needs one exact owner-confirmed grant.
3. **User-wallet EVM**: ordinary EVM preparations require the user's wallet signature.
4. **Optional bounded EVM execution**: a deployment may expose a separate same-host, owner-gated EVM executor such as MAD. Verify its status and policy before saying it is available. Never infer it from the public package or the generic signer.

Do not turn a deployment fact into a universal claim. If no bounded EVM executor is installed or healthy, say the current deployment cannot execute EVM. Do not say Oracle can never execute EVM.

## Binding vocabulary

- `watch`, `watch this`, `ping`, `ping me`, `alert`, and `notify` mean notification only.
- Persist them as `active: true` and `actionMode: alert_only`.
- `arm` means authorization intent for one exact bounded action.
- Persist it as `active: true` and `actionMode: execute` only after the exact action and owner authorization are present.
- Never convert `watch` into execution.
- Never convert `arm` into a watch.
- A status field such as `armed` is not action authority. Current records require explicit `active` and `actionMode` fields.

Before accepting `arm`, require the exact chain, token pair, amount or fraction, trigger, recipient, router, deadline, slippage bound, and approval bound. Require the owner-gated executor to be healthy and disarmed until that exact action is authorized. Refuse global, implied, or reusable authorization.

## Execution states

Report each state separately:

- `executionReady`
- `requiresUserSignature`
- `signingReady`
- `broadcastReady`

A quote is not a preparation. A preparation is not a signature. A signature is not a broadcast. A broadcast is not mined execution. Claim success only after a transaction hash, successful receipt, and expected balance delta.

ERC-20 approval is a separate transaction. Use an exact bounded amount unless the user explicitly authorizes another cap. Never silently create an unlimited approval.
