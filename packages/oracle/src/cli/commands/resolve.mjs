import { lookupName, resolveName, ADDRESS_RE, NAME_SOURCES } from "../../data/names.mjs";

const USAGE = `oracle resolve <name-or-address> [--json]

  oracle resolve demi.hl
  oracle resolve vitalik.eth
  oracle resolve 0x1111111111111111111111111111111111111111

Reads on-chain name records. No API key: HL Names publishes a paid REST API,
but the contract answers primaryName(address) for free.

Sources, in priority order: ${NAME_SOURCES.join(", ")}.`;

async function runResolve(argv = []) {
  const args = argv.filter((a) => a !== "--json");
  const asJson = argv.includes("--json");
  const query = (args[0] || "").trim();

  if (!query || query === "--help" || query === "-h") {
    process.stdout.write(USAGE + "\n");
    return query ? 0 : 1;
  }

  try {
    if (ADDRESS_RE.test(query)) {
      const hit = await lookupName(query);
      if (asJson) {
        process.stdout.write(JSON.stringify({ address: query, name: hit?.name ?? null, source: hit?.source ?? null }) + "\n");
        return 0;
      }
      if (!hit) {
        process.stdout.write(`${query}\n  no name record found\n`);
        return 0;
      }
      process.stdout.write(`${query}\n  ${hit.name}  [${hit.source}]\n`);
      return 0;
    }

    const hit = await resolveName(query);
    if (asJson) {
      process.stdout.write(JSON.stringify({ name: query, address: hit?.address ?? null, source: hit?.source ?? null }) + "\n");
      return 0;
    }
    if (!hit) {
      // Unresolved is an answer, not an error: the name may simply be unregistered.
      process.stdout.write(`${query}\n  unresolved (no owner record)\n`);
      return 0;
    }
    process.stdout.write(`${query}\n  ${hit.address}  [${hit.source}]\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`resolve failed: ${err?.message || err}\n`);
    return 1;
  }
}

export default {
  name: "resolve",
  summary: "resolve .hl/.hype/.eth names to addresses and back",
  usage: USAGE,
  async run(ctx) {
    return runResolve(ctx.argv || []);
  },
};
