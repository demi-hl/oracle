# Oracle unified CLI

Root command: `oracle <noun> <verb> [args]`.

The public `@oracle-agent/oracle` CLI is standalone and prepare-only. Hermes is
optional. The public package does not import a signer, hold a wallet key, submit,
or broadcast.

## Install and first run

```bash
npm i -g @oracle-agent/oracle            # Node >= 20.19
oracle --version
oracle auth login claude               # or codex / grok
oracle
oracle doctor
```

API-key users can run `oracle auth api-key <provider>`; interactive input is
hidden. Do not pass credentials as command-line arguments. Linux, Windows, and
macOS apps are in beta.

## Command groups

### Chat and model authentication

```bash
oracle
oracle chat
oracle chat -q "research HYPE funding"
oracle auth login claude|codex|grok
oracle auth api-key openrouter|openai|xai|deepseek|gemini|custom
oracle auth status [--json]
oracle auth logout <provider>
oracle model
oracle model --show
oracle model --provider <provider> --model <model>
```

OAuth and stored API keys use the OS credential store when available and a
private `0600` local fallback otherwise. Status output never prints credentials.

### Chain selection

```bash
oracle chain list
oracle chain use hyperliquid
oracle chain show
oracle chain clear
```

Inside chat, `/chain` lists or selects the active chain. Chain selection changes
routing context, not custody or authorization.

### Read, research, and prepare

```bash
oracle scan --help
oracle route --help
oracle data serve
oracle public serve --port 8799
oracle doctor [--json]
```

`oracle data serve` binds the local read plane to `127.0.0.1:8787`.
`oracle public serve` binds the unsigned public HTTP plane to loopback. Neither
command creates authentication. Do not expose either port directly.

### Optional Hermes integration

```bash
oracle bootstrap [--status|--upgrade]
oracle init                 # dry run
oracle init --apply
oracle setup
oracle setup telegram --allowed-users <id>
oracle setup messaging
oracle setup gateway [status|start|stop|restart]
```

`oracle bootstrap` installs an isolated compatibility runtime and never modifies
system Python. `oracle init --apply` writes specialist profiles and local
attestation configuration; it does not write a wallet private key.

Messaging token prompts are hidden. Avoid `--token` in a normal shell because
arguments can be retained in history or visible to other local users.

### MCP connectors

```bash
oracle mcp install claude-code
oracle mcp install claude-desktop
oracle mcp install codex
oracle mcp install chatgpt
oracle mcp install cursor
oracle-data-mcp
```

See [connectors.md](connectors.md). Connector installation exposes public
read/prepare tools only unless a separate owner-operated boundary is explicitly
installed and verified.

## Chat commands

- `/chain` — list or select the active chain.
- `/setup` — optional messaging setup.
- `/model` — switch models; the persona remains Oracle.

Terminal and configured messaging channels can enter the same Hermes profile,
but the transport and selected model never create authority. Shared hosted
sessions must remain isolated and read/prepare-only.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | success |
| `1` | usage, configuration, or general error |
| `2` | separately installed operator reported an error |
| `3` | private operator command requested but unavailable |
| `4` | required local data server not running |

## Doctor semantics

A standalone public install can legitimately warn that the optional data server,
Hermes runtime, profiles, or signer are absent. A Node-version failure is
blocking. Signing readiness is not required for the public package.

## Safety semantics

- Read, quote, simulate, and prepare are not execution.
- The wallet address in a preparation request must be the real signer.
- A prepared artifact is inert until a user-controlled wallet signs it.
- A signature request or transaction hash is not a successful receipt.
- No CLI flag turns a public install into DEMI's operator lane.
- A shared hosted service needs server-side authentication and per-user isolation.

## More

- [Full setup](../SETUP.md)
- [Public surface and environment variables](public-surface.md)
- [Locals Only 0% fee waiver](locals-only-fee-waiver.md)
- [Buzz integration](buzz-integration.md)
