import fs from "node:fs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      flags[key] = next;
      index++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

function jsonFile(path, label) {
  if (!path) throw new Error(`${label} path required`);
  const text = path === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function numberFlag(value, label) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

const HELP = `oracle strategy <draft|validate|backtest|optimize|evidence|shadow|prepare> [args]

  oracle strategy draft "Long BTC when the 20 EMA crosses above the 50 EMA"
  oracle strategy validate strategy.json
  oracle strategy backtest strategy.json [--bars bars.json] [--count 1500]
  oracle strategy optimize strategy.json [--bars bars.json] [--max-trials 64]
  oracle strategy evidence strategy.json [--bars bars.json]
  oracle strategy shadow list
  oracle strategy shadow start strategy.json
  oracle strategy shadow step <id> [--bars bars.json]
  oracle strategy shadow stop <id>
  oracle strategy prepare strategy.json --evidence evidence.json --shadow-id <id> [--caps caps.json]

Strategy simulation and shadowing are local and deterministic. Prepare returns an integrity-bound artifact, HMAC-authenticated when local attestation is configured. Oracle public never signs or broadcasts.
`;

export default {
  name: "strategy",
  summary: "deterministic Hyperliquid strategy lab, evidence, shadow, prepare-only handoff",
  group: "read",
  usage: "oracle strategy <draft|validate|backtest|optimize|evidence|shadow|prepare> [args]",
  async run(ctx) {
    const { flags, positional } = parseArgs(ctx.argv);
    if (flags.help || positional.length === 0) {
      process.stdout.write(HELP);
      return 0;
    }
    const [operation, ...rest] = positional;
    const { runStrategyOperation } = await import("../../strategy/service.mjs");
    const input = {
      nowMs: Date.now(),
      count: numberFlag(flags.count, "count"),
    };

    if (operation === "draft") {
      input.prompt = rest.join(" ").trim();
    } else if (["validate", "backtest", "optimize", "evidence"].includes(operation)) {
      input.strategy = jsonFile(rest[0], "strategy");
      if (flags.bars) input.bars = jsonFile(flags.bars, "bars");
      input.maxTrials = numberFlag(flags["max-trials"], "max-trials");
    } else if (operation === "shadow") {
      const action = rest[0];
      if (!action) throw new Error("shadow action required");
      input.action = action;
      if (action === "start") input.strategy = jsonFile(rest[1], "strategy");
      if (action === "step") {
        input.id = rest[1];
        if (flags.bars) input.bars = jsonFile(flags.bars, "bars");
      }
      if (action === "stop") input.id = rest[1];
    } else if (operation === "prepare") {
      input.strategy = jsonFile(rest[0], "strategy");
      input.evidence = jsonFile(flags.evidence, "evidence");
      input.shadowId = flags["shadow-id"];
      if (flags.caps) input.caps = jsonFile(flags.caps, "caps");
    } else {
      throw new Error(`unknown strategy operation: ${operation}`);
    }

    const result = await runStrategyOperation(operation, input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  },
};
