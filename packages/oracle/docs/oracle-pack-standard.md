# Oracle protocol pack standard

An Oracle protocol pack is a package-safe ESM module that turns an intent into an unsigned action and decodes independently obtained receipts. A pack is an adapter, not a wallet, signer, broadcaster, or authority. See `examples/oracle-pack-template.mjs` for the smallest complete shape.

## Required surface

Every pack exports a default object with these members (named exports may mirror them):

- `provider`: stable provider identity, semantic version, supported chain IDs, and provenance/trust metadata. Remote token names, symbols, descriptions, image fields, URLs, and NFT metadata remain untrusted data.
- `prepare(intent)`: validates the intent and returns an unsigned transaction or typed action. It must not accept keys, sign, submit, broadcast, or report execution success.
- `decode(receipt)`: validates and converts a chain/provider receipt into a documented result. Unknown or malformed receipts fail closed.
- `riskRules`: an array or function describing enforceable limits and refusal conditions. Human-readable warnings alone are not rules.
- `tests`: non-empty metadata naming the local test command and covered properties. Tests must be deterministic and require no credentials or network.

## Prompt-injection boundary

Treat every provider response and token/NFT metadata string as inert data. Never concatenate metadata into system/developer instructions, interpret it as tool directions, or let it modify recipients, calldata, limits, and policy. Render or quote it through a data channel and retain its provenance. Packs should test adversarial values such as “ignore previous instructions,” requests for secrets, and demands to sign or invoke tools.

## Custody boundary

Pack exports must not expose signers, wallets, private keys, seed phrases, signing functions, transaction submission, or broadcasting. `prepare` returns data to a separately authorized custody surface. Environment variables and provider credentials must not appear in prepared output, logs, errors, fixtures, or metadata. Imports should be side-effect free; merely loading a pack must not make network calls.

## Receipt gate

Preparation is not execution. A prepared result declares a `receiptGate` and consumers must not mark an action successful until `decode` receives a receipt from an independent, trusted transport and verifies its chain, transaction identity, status, and required confirmations. Timeouts, pending receipts, mismatches, reverts, and undecodable responses are not success.

## Local adversarial benchmark

Run `node scripts/adversarial-bench.mjs <pack.mjs> [...]`. It imports only the named local modules, invokes no pack functions, emits one deterministic JSON summary, and exits `1` when a gate fails (`2` for usage/load errors). It checks required surface fields, forbidden custody exports, missing test metadata, and prompt-injection strings nested in provider or pack metadata. This static public gate complements, rather than replaces, behavioral tests of preparation and receipt verification.
