// oracle harness — detect installed agent harnesses on this machine.
//
// Scans PATH for Agent Plugins-compatible clients, shows which ones
// Oracle can delegate to. Native standalone is always the default.
//
// Commands:
//   oracle harness detect             scan PATH, print installed harnesses
//   oracle harness list               same as detect (alias)

import { detectInstalledHarnesses } from "../../tui/backend.mjs";

function usage() {
  return [
    "oracle harness — detect installed agent harnesses",
    "",
    "  oracle harness detect    scan PATH for Agent Plugins-compatible clients",
    "",
    "Oracle runs natively. If you prefer a different harness,",
    "set ORACLE_CHAT_BACKEND=<name>.",
    "",
    "Detected: opencode, claude, codex, cursor, windsurf, aider, continue, hermes",
  ].join("\n");
}

export default {
  name: "harness",
  summary: "detect installed agent harnesses",
  usage,
  async main(args, _env) {
    const sub = args[0];
    if (sub === "help" || sub === "--help" || sub === "-h") {
      process.stdout.write(usage() + "\n");
      return 0;
    }
    if (sub && sub !== "detect" && sub !== "list") {
      process.stderr.write(`oracle harness: unknown subcommand '${sub}'\n`);
      process.stderr.write(usage() + "\n");
      return 1;
    }

    const harnesses = detectInstalledHarnesses();

    if (harnesses.length === 0) {
      process.stderr.write("No agent harnesses detected on PATH.\n");
      process.stderr.write("Oracle runs natively — no external agent required.\n");
      return 0;
    }

    const native = harnesses.find(h => h.kind === "oracle");
    const others = harnesses.filter(h => h.kind !== "oracle");

    process.stdout.write("\nOracle native chat: default\n\n");
    process.stdout.write("Installed harnesses:\n");
    for (const h of others) {
      process.stdout.write(`  ${h.label.padEnd(22)} ${h.path}\n`);
    }
    if (others.length === 0) {
      process.stdout.write("  (none — Oracle runs standalone)\n");
    }
    process.stdout.write(`\nSet ORACLE_CHAT_BACKEND=<name> to use a different harness.\n`);
    return 0;
  },
};
