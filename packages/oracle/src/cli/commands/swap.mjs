import { prepareSwapForDesk, SwapPrepareError } from "../../desk/swap-prepare.mjs";

const USAGE = `oracle swap <chain> <sellAsset> <buyAsset> <amount> --taker <address> [--source X] [--json]

  oracle swap base USDC WETH 5 --taker 0xYourWallet
  oracle swap 8453 0x8335...913 WETH 5 --taker 0xYourWallet --json

Prepares an UNSIGNED swap transaction. Oracle never signs or broadcasts:
your wallet is the only thing that can authorize the result.`;

function flag(argv, name) {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split("=").slice(1).join("=");
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

export default {
  name: "swap",
  summary: "prepare an unsigned swap (quote + calldata)",
  group: "read",
  usage: USAGE,
  async run(ctx) {
    const argv = ctx.argv || [];
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(USAGE + "\n");
      return 0;
    }
    const json = argv.includes("--json");
    const positional = argv.filter((a) => !a.startsWith("--"));
    // --taker consumes the token after it; drop that from the positional set.
    const takerVal = flag(argv, "taker");
    const pos = positional.filter((a) => a !== takerVal);
    const [chain, sellSymbol, buySymbol, sellAmount] = pos;

    if (!chain || !sellSymbol || !buySymbol || !sellAmount) {
      process.stderr.write(USAGE + "\n");
      return 1;
    }
    if (!takerVal) {
      process.stderr.write("error: --taker <address> is required. A prepared transaction is built FOR a wallet.\n");
      return 1;
    }

    let out;
    try {
      out = await prepareSwapForDesk({
        chainId: chain,
        sellSymbol,
        buySymbol,
        sellAmount,
        taker: takerVal,
        source: flag(argv, "source") || undefined,
      });
    } catch (e) {
      if (e instanceof SwapPrepareError) {
        process.stderr.write(`error: ${e.message}\n`);
        return 1;
      }
      throw e;
    }

    if (json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return out.ok ? 0 : 1;
    }

    if (!out.ok) {
      process.stdout.write(`could not prepare: ${out.reason}\n`);
      if (out.priceImpactBlocked) {
        process.stdout.write("reason kind: price impact guard rejected the venue (thin or drained liquidity)\n");
      }
      return 1;
    }

    const q = out.quote;
    process.stdout.write(`route:       ${q.routeLabel}\n`);
    process.stdout.write(`sell:        ${q.sellAmount} ${q.sellSymbol}\n`);
    process.stdout.write(`receive:     ${q.buyAmountFormatted ?? "unknown"} ${q.buySymbol}\n`);
    if (q.minOut) process.stdout.write(`minOut:      ${q.minOut} (raw)\n`);
    process.stdout.write(
      `slippage:    ${q.slippageBps == null ? "not quoted by route" : (q.slippageBps / 100).toFixed(2) + "%"}\n`,
    );
    process.stdout.write(
      `impact:      ${q.priceImpactPct == null ? "unknown" : q.priceImpactPct.toFixed(3) + "%"}\n`,
    );
    if (q.requiresApproval) {
      process.stdout.write(`\napproval required first:\n`);
      process.stdout.write(`  token   ${q.requiresApproval.token}\n`);
      process.stdout.write(`  spender ${q.requiresApproval.spender}\n`);
    }
    if (out.transaction) {
      process.stdout.write(`\nunsigned transaction:\n`);
      process.stdout.write(`  to    ${out.transaction.to}\n`);
      process.stdout.write(`  value ${out.transaction.value}\n`);
      process.stdout.write(`  data  ${String(out.transaction.data).slice(0, 42)}... (${String(out.transaction.data).length} chars)\n`);
    }
    for (const w of q.warnings || []) process.stdout.write(`\nWARNING: ${w}\n`);
    process.stdout.write(`\nUNSIGNED. Your wallet must review and sign this. Oracle holds no keys.\n`);
    return 0;
  },
};
