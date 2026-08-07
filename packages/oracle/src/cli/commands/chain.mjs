import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findWorkingChain,
  listWorkingChains,
  renderChainList,
} from "../chain-catalog.mjs";
import {
  clearActiveChain,
  readActiveChain,
  writeActiveChain,
} from "../chain-state.mjs";

function usage() {
  return [
    "oracle chain — pick the build/trade surface",
    "",
    "  oracle chain                 list working chains",
    "  oracle chain list            same",
    "  oracle chain show            show active chain",
    "  oracle chain use <name>      select (hyperliquid, base, solana, ...)",
    "  oracle chain clear           unset",
    "  oracle chain --json          machine output",
    "",
    "chat:",
    "  /chain",
    "  /chain hyperliquid",
    "  /chain show",
  ].join("\n");
}

function printList(json) {
  const active = readActiveChain();
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          active,
          chains: listWorkingChains(),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    renderChainList({ selectedKey: active?.key || null }),
  );
  return 0;
}

function printShow(json) {
  const active = readActiveChain();
  if (json) {
    process.stdout.write(JSON.stringify({ active }, null, 2) + "\n");
    return active ? 0 : 1;
  }
  if (!active) {
    process.stdout.write("active: none\nrun: oracle chain use hyperliquid\n");
    return 1;
  }
  process.stdout.write(
    `active: ${active.key}  id=${active.chainId}  agent=${active.agent}\n`,
  );
  return 0;
}

function useChain(query, json) {
  try {
    const active = writeActiveChain(query);
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, active }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `selected ${active.key} (${active.chainId}) · agent ${active.agent}\n` +
          `build/trade context pinned for this machine\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err?.code === "UNKNOWN_CHAIN") {
      process.stderr.write(`oracle chain: unknown '${query}'\n`);
      process.stderr.write("try: oracle chain list\n");
      return 1;
    }
    throw err;
  }
}

export default {
  name: "chain",
  summary: "list/select working chains (hyperliquid, base, solana, ...)",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = [...ctx.argv];
    const json = args.includes("--json");
    const clean = args.filter((a) => a !== "--json");
    const verb = (clean[0] || "list").toLowerCase();
    const rest = clean.slice(1);

    if (["-h", "--help", "help"].includes(verb)) {
      process.stdout.write(usage() + "\n");
      return 0;
    }
    if (["list", "ls"].includes(verb)) return printList(json);
    if (["show", "status", "current"].includes(verb)) return printShow(json);
    if (["clear", "unset", "none"].includes(verb)) {
      clearActiveChain();
      process.stdout.write(json ? "{\"ok\":true,\"active\":null}\n" : "active chain cleared\n");
      return 0;
    }
    if (["use", "set", "select", "pick"].includes(verb)) {
      const q = rest.join(" ").trim();
      if (!q) {
        process.stderr.write("usage: oracle chain use <name>\n");
        return 1;
      }
      return useChain(q, json);
    }

    // bare token: oracle chain hyperliquid
    if (findWorkingChain(verb)) return useChain(verb, json);

    // interactive pick when tty and no args beyond list default already handled
    if (!clean.length && process.stdin.isTTY) {
      const chains = listWorkingChains();
      process.stdout.write(renderChainList({ selectedKey: readActiveChain()?.key }));
      const rl = readline.createInterface({ input, output });
      try {
        const answer = (await rl.question("chain> ")).trim();
        if (!answer) return 0;
        return useChain(answer, false);
      } finally {
        rl.close();
      }
    }

    process.stderr.write(`oracle chain: unknown verb '${verb}'\n${usage()}\n`);
    return 1;
  },
};
