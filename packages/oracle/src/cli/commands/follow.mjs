import { followWallet, DEFAULT_ENDPOINTS } from "../../data/providers/wallet-watch.mjs";
import { resolveName, ADDRESS_RE } from "../../data/names.mjs";

const CHAIN_NAMES = { 1: "ethereum", 8453: "base", 42161: "arbitrum" };
const NAME_TO_ID = Object.fromEntries(Object.entries(CHAIN_NAMES).map(([id, n]) => [n, Number(id)]));

const USAGE = `oracle follow <name-or-address> [--chain <name>] [--blocks <n>] [--json]

  oracle follow vitalik.eth
  oracle follow demi.hl --chain base
  oracle follow 0x4d47b6757afd42c3dbd9691b71b43d74afa4b6b2 --blocks 20000 --json

Reads ERC20 transfer activity for a wallet. Read-only: this calls
eth_getLogs and eth_blockNumber and nothing else, so it can never move funds.

Chains: ${Object.values(CHAIN_NAMES).join(", ")}. Default: ethereum.
Lookback defaults to 40000 blocks. Endpoints are keyless.

Note publicnode-class RPCs are deliberately excluded: they retain only ~128
blocks, so they return an empty result instead of an error.`;

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fmtValue(v) {
  const s = String(v ?? "");
  return s.length > 22 ? `${s.slice(0, 19)}...` : s;
}

async function runFollow(argv = []) {
  const asJson = argv.includes("--json");
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") continue;
    if (a === "--chain" || a === "--blocks") { i += 1; continue; }
    positional.push(a);
  }
  const query = (positional[0] || "").trim();

  if (!query || query === "--help" || query === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return query ? 0 : 1;
  }

  const chainArg = (flagValue(argv, "--chain") || "ethereum").toLowerCase();
  const chainId = NAME_TO_ID[chainArg] ?? Number(chainArg);
  if (!DEFAULT_ENDPOINTS[chainId]) {
    process.stderr.write(`follow: unsupported chain "${chainArg}". Supported: ${Object.values(CHAIN_NAMES).join(", ")}\n`);
    return 1;
  }

  const blocksArg = flagValue(argv, "--blocks");
  const lookbackBlocks = blocksArg ? Number(blocksArg) : 40000;
  if (!Number.isFinite(lookbackBlocks) || lookbackBlocks <= 0) {
    process.stderr.write(`follow: --blocks must be a positive number, got "${blocksArg}"\n`);
    return 1;
  }

  try {
    // A name is a fine way to name a wallet, so resolve it the same way
    // `oracle resolve` does rather than making the user paste hex.
    let address = query;
    let resolvedFrom = null;
    if (!ADDRESS_RE.test(query)) {
      const hit = await resolveName(query);
      if (!hit?.address) {
        process.stderr.write(`follow: could not resolve "${query}" to an address\n`);
        return 1;
      }
      address = hit.address;
      resolvedFrom = query;
    }

    const result = await followWallet(address, {
      chains: [chainId],
      lookback: lookbackBlocks,
      onWarn: asJson ? undefined : (m) => process.stderr.write(`  warn: ${m}\n`),
    });

    const events = result.events || [];
    if (asJson) {
      process.stdout.write(`${JSON.stringify({
        address,
        resolvedFrom,
        chain: CHAIN_NAMES[chainId] || String(chainId),
        lookbackBlocks,
        count: events.length,
        errors: result.errors || [],
        events,
      })}\n`);
      return 0;
    }

    const label = resolvedFrom ? `${resolvedFrom}  ${address}` : address;
    process.stdout.write(`${label}\n`);
    process.stdout.write(`  ${CHAIN_NAMES[chainId] || chainId} · last ${lookbackBlocks} blocks · ${events.length} transfer${events.length === 1 ? "" : "s"}\n`);

    if (!events.length) {
      // Empty is a scoped result, not proof the wallet is idle.
      process.stdout.write(`  no ERC20 transfers in this window\n`);
    }
    for (const e of events.slice(0, 25)) {
      const dir = e.to?.toLowerCase() === address.toLowerCase() ? "in " : "out";
      process.stdout.write(`  ${dir} blk ${e.blockNumber}  token ${e.token}  ${fmtValue(e.value)}\n`);
    }
    if (events.length > 25) {
      process.stdout.write(`  ... ${events.length - 25} more (use --json for all)\n`);
    }
    for (const err of result.errors || []) {
      process.stderr.write(`  error: ${err.stage || "rpc"}: ${err.error}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`follow failed: ${err?.message || err}\n`);
    return 1;
  }
}

export default {
  name: "follow",
  summary: "read a wallet's recent ERC20 transfer activity",
  group: "read",
  usage: USAGE,
  async run(ctx) {
    return runFollow(ctx.argv || []);
  },
};
