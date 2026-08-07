# Locals-holder beta launch gate

## Current verdict

**HOLD for a shared, holder-gated hosted launch.**

The public Oracle package is suitable for a closed beta in which each verified
participant installs it locally and remains in read, research, simulation, and
unsigned-prepare mode. This repository does **not** currently contain an
integrated Locals ownership gate for a shared website, API, chat bot, or agent
session.

A working static website, wallet-address text field, hidden navigation item,
invite URL, Discord role, or client-side NFT lookup is not holder authentication.

## Allowed beta scope now

- Distribute the public npm CLI to manually verified holders.
- Let each user authenticate their own model provider.
- Read public market and chain data.
- Research public wallet addresses supplied by that user.
- Quote, simulate, and prepare unsigned wallet artifacts.
- Let the user's own wallet independently review, sign, and submit.
- Keep `oracle data serve` and `oracle public serve` on loopback.

## Not allowed in the holder beta

- DEMI's executor, signer, wallet, balances, holdings, PnL, or private sessions.
- Shared signer tokens, vault passphrases, provider keys, bot tokens, or RPC keys.
- Server-side signing, broadcasting, automated trading, stop arming, or owner grants.
- A holder-access UI that merely hides controls in the browser.
- Direct exposure of ports `8787`, `8799`, or any owner-local signer port.
- A shared Hermes profile or memory store across unrelated holders.
- Calling a prepared artifact, signature request, or queued action a fill.

## Required holder authentication

Before a shared hosted beta can move from HOLD to GO, implement and test all of
the following at the server boundary:

1. The browser requests a single-use nonce from the beta backend.
2. The wallet signs a domain-separated challenge containing the nonce, origin,
   intended audience, chain, and expiry.
3. The server recovers the signer and rejects mismatched origin, audience,
   chain, expiry, or previously used nonce.
4. The server reads the configured Locals collection contract on the configured
   chain and proves the recovered address currently owns at least one token.
5. Contract address and chain are deployment configuration, not browser input.
6. Successful admission creates a short-lived, `HttpOnly`, `Secure`,
   `SameSite=Strict` session cookie. Do not place bearer credentials in URLs or
   local storage.
7. Holder ownership is rechecked on renewal and after a bounded TTL. A
   transferred token must not grant indefinite access.
8. All protected API routes enforce the session server-side. The UI check is
   presentation only.
9. Non-holder, expired, replayed, wrong-chain, and malformed signatures fail
   closed without leaking whether another wallet is admitted.
10. Rate limits apply before expensive RPC work. Production needs a controlled
    edge/WAF in addition to the in-process limiter.

## User and data isolation

Each holder must receive an independent session and storage namespace:

- no access to another holder's chat, memory, address book, audit entries,
  prepared artifacts, portfolio history, or receipts;
- no access to owner/operator profiles, tools, environment, filesystem, or
  network services;
- no shared model credential unless the service explicitly owns and meters it;
- request logs redact credentials, signatures, prepared calldata, and upstream
  error URLs before persistence;
- disconnect and account deletion revoke the session and remove user-scoped
  stored data according to the published retention policy.

## Network boundary

`oracle data serve` and `oracle public serve` enforce loopback defaults. A hosted
beta should place a separate, reviewed application gateway in front of them:

```text
holder wallet
    -> TLS edge + rate limit
    -> signed challenge + Locals ownership check
    -> per-user session gateway
    -> Oracle public read/prepare plane on loopback
```

The owner-local signer/executor does not sit behind this gateway. It remains a
separate private service and must never be reachable from holder traffic.

## Launch tests

A GO requires recorded proof for at least these cases:

- holder wallet admitted;
- non-holder denied;
- token transferred away, then denied after the bounded TTL;
- wrong collection and wrong chain denied;
- challenge replay denied;
- expired challenge and expired session denied;
- tampered cookie denied;
- protected API called without UI, denied;
- two holders cannot read each other's data;
- holder cannot discover owner/operator routes or state;
- private key, seed phrase, bot token, signer token, and provider key shapes are
  rejected or redacted from request, response, audit, and log paths;
- `/public/*` exposes no sign, send, broadcast, execute, or arm route;
- execution flags remain off and no signer is configured;
- loopback services are unreachable directly from the public network;
- rollback disables admission without taking the static status page down.

Run the repository gates as well:

```bash
npm run gate:release
npm run test:boundary
npm test
npm run typecheck
npm run build
npm run scan:secrets
```

## Operational GO checklist

- [ ] Exact collection contract and chain independently verified.
- [ ] Server-side ownership gate implemented and adversarially tested.
- [ ] Per-user session and data isolation verified.
- [ ] Public plane contains no signer/executor import or route.
- [ ] Owner/private infrastructure is on a separate network and credential set.
- [ ] TLS, edge limits, monitoring, retention, support, and incident contacts are live.
- [ ] One-command admission kill switch and rollback tested.
- [ ] Beta scope and limitations are shown before wallet connection.
- [ ] Linux, Windows, and macOS apps are labeled beta.

Until every box is checked with current deployment evidence, the correct launch
status is **HOLD**, even if the npm package and static website are working.
