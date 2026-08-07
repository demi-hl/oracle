# Buzz integration

Oracle exposes an unsigned public HTTP contract for Buzz. Buzz calls Oracle over
HTTP; it does not import or embed the private signer/executor.

## Current boundary

- Plane: public read, connect, grant, auth verification, and audit.
- Custody: user signs grants and capabilities in the user's wallet.
- Posture: `DISARMED`.
- Private keys: never accepted.
- Broadcast: unavailable from the public server.
- Conversational Oracle embedding: separate Buzz client work; the HTTP contract
  alone does not create a persistent Oracle chat session.

Source: `src/public-api/buzz-integration.mjs`.

## Start locally

```bash
oracle public serve --port 8799
curl -fsS http://127.0.0.1:8799/public/health
curl -fsS http://127.0.0.1:8799/public/buzz
```

The server binds to loopback. Source code or a static Oracle website is not proof
that the API is running. Check `/public/health` on the deployment you intend to
use before enabling a Buzz client.

## Discovery and capability flow

Buzz begins with:

```http
GET /public/buzz
```

The returned discovery object is the contract source of truth for the running
server. The current API family includes:

- `GET /public/health`
- `GET /public/config`
- `POST /public/connect/request`
- `POST /public/connect/assemble`
- `POST /public/grants/active`
- `POST /public/grants/get`
- `POST /public/buzz/auth/preimage`
- `POST /public/buzz/auth/verify`
- `POST /public/buzz/audit/append`
- `POST /public/buzz/audit/verify`
- `POST /public/buzz/audit/entries`

Do not hardcode this list without checking discovery; a deployment can lag the
source tree.

The client asks Oracle for the exact capability preimage, the owner wallet signs
that preimage, and Oracle verifies the supplied capability. The server never
mints a capability with a house key.

## Audit contract

Buzz public events append to a SHA-256 hash chain. The server restricts public
audit actions and scans details for secret material before append and response.
A valid audit entry proves the hash-chain record exists; it does not prove an
on-chain action executed. On-chain success still requires a real transaction
hash, successful receipt, and expected state change.

## Hard prohibitions

Buzz must never use this integration to:

- reach a private executor or owner wallet;
- request, store, or forward private keys, seed phrases, vault passphrases,
  signer tokens, provider keys, or bot tokens;
- mint server-side capabilities with a house key;
- treat a verified capability as blanket execution authority;
- expose Oracle's loopback service directly to the internet;
- mix holder sessions, memories, portfolios, grants, or audit streams;
- describe prepare, sign-request, or queue state as execution.

## Hosted deployment

For a hosted Buzz integration, place Buzz's authenticated backend in front of
Oracle's loopback public server. Use TLS, strict origin and audience binding,
short-lived sessions, rate limits, request-size caps, redacted logs, and a
controlled proxy that overwrites forwarded-IP headers.

A hosted Buzz service requires server-side authentication and per-user isolation.
Locals Only ownership only changes Oracle's integrator fee and does not grant or
restrict Buzz access.

## Conversational Oracle in Buzz

Embedding the full Oracle conversation requires a separate bridge:

1. Buzz authenticates the user and holder session.
2. Buzz assigns a distinct Oracle session/profile namespace per user.
3. Buzz streams responses and renders structured tool results as Buzz cards.
4. The Oracle session receives only public read/prepare tools.
5. Wallet review and signatures stay in the Buzz client or user's wallet.
6. Owner/operator tools and DEMI's sessions are never mounted into that tenant.

Until that bridge exists and passes isolation tests, say **“Buzz HTTP contract
available”**, not **“Oracle chat is integrated into Buzz.”**

## Release verification

```bash
npm run test:boundary
npm test
npm run scan:secrets
```

Then verify the exact deployed URL and discovery response. A passing source test
does not prove a remote deployment is live.
