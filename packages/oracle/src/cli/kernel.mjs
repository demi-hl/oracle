import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT, packageBin, paths } from "./paths.mjs";
import {
  dispatchOperator,
  resolveOperator,
  printOperatorNotInstalled,
  SIGN_NOUNS,
} from "./operator-dispatch.mjs";

const HELP_HEADER = `oracle — self-custody multichain agent control plane`;

const STATIC_HELP = `READ / RESEARCH (no keys, this package)
  oracle                      open the native Oracle chat (TTY)
  oracle bootstrap            optional: install an isolated Hermes compatibility runtime
  oracle init                 install agent lanes + read plane (dry-run by default)
  oracle doctor               check read plane; checks signer too when installed
  oracle chat                 premium boxed oracle chat (multi-model)
  oracle model                choose standalone/Hermes provider and any compatible model
  oracle auth                 Claude/Codex/Grok OAuth or securely stored provider API keys
  oracle chain                list/select working chains (hyperliquid, base, ...)
  oracle setup                telegram/discord/slack messaging menu
  oracle data serve|call|catalog|health
  oracle data-mcp             start the read-only MCP server
  oracle scan chains|head|token|pools|risk|quote|sell
  oracle route swap|bridge|prepare|prepare-bridge
  oracle swap <chain> <sell> <buy> <amt> --taker <addr>   unsigned swap + calldata
  oracle farm methods|discover|airdrop
  oracle prepare              build an unsigned swap (alias of route prepare)
  oracle equities venues|quote|prepare
                              Crossbook: HIP-3 / Arcus / RH / Solana / TON best-ex
  oracle public serve         secret-free public HTTP surface
  oracle mcp install <t>      wire Oracle into claude-code|claude-desktop|codex|chatgpt
  oracle plugins install|list|remove|scan|setup
                              manage Agent Plugins (open-standard portable agent tooling)
  oracle harness detect|list   scan PATH for installed agent harnesses (opencode, claude, codex, cursor…)
  oracle fees status|check     check Locals Only 0% fee eligibility
  oracle upgrade              upgrade installed agent lanes

SIGNING (dispatches to @oracle-agent/operator on THIS machine; never in this package)
  oracle sign init|doctor     provision / check the local signer (opt-in)
  oracle vault ...            encrypt local key files at rest
  oracle signer / runner      loopback signer daemon / action runner
  oracle credential ...       OS credential store glue

oracle <noun> --help for details. Keys never leave your machine; this package
cannot sign — signing commands run the locally installed operator package.
`;

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function commandsDir() {
  const sourceDir = path.join(PACKAGE_ROOT, "src", "cli", "commands");
  if (fs.existsSync(sourceDir)) return sourceDir;
  return path.join(PACKAGE_ROOT, "dist", "cli", "commands");
}

export async function discoverCommands() {
  const dir = commandsDir();
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const mod = await import(pathToFileURL(full).href + `?t=${Date.now()}`);
      const cmd = mod.default;
      if (!cmd || typeof cmd !== "object" || typeof cmd.run !== "function") {
        continue;
      }
      const name = cmd.name || file.replace(/\.mjs$/, "");
      out.set(name, { ...cmd, name, __file: full });
    } catch (err) {
      if (process.env.ORACLE_CLI_DEBUG) {
        console.error(`oracle: failed loading command ${file}: ${err.message}`);
      }
    }
  }
  return out;
}

export function renderHelp(version, commands) {
  const lines = [];
  lines.push(`${HELP_HEADER} (v${version})`);
  lines.push("");
  lines.push(STATIC_HELP.trimEnd());

  const extras = [];
  for (const cmd of commands.values()) {
    if (["help", "version"].includes(cmd.name)) continue;
    const known = new Set([
      "init","doctor","chat","model","chain","setup","data","data-mcp","scan","route","prepare","swap","farm","follow","equities","public","mcp","plugins","harness","upgrade","bootstrap",
      "sign","vault","signer","runner","credential",
    ]);
    if (!known.has(cmd.name) && cmd.summary) {
      extras.push(`  oracle ${cmd.name.padEnd(20)} ${cmd.summary}`);
    }
  }
  if (extras.length) {
    lines.push("");
    lines.push("ADDITIONAL");
    lines.push(...extras);
  }
  return lines.join("\n") + "\n";
}

function unknownNounMessage(noun, commands) {
  const known = [...commands.keys()].sort();
  const list = known.length ? known.join(", ") : "(none loaded yet)";
  return `oracle: unknown command '${noun}'. Known: ${list}\nTry: oracle --help\n`;
}

function buildCtx(argv) {
  return {
    argv,
    root: PACKAGE_ROOT,
    // Commands must resolve sibling bins through this, never path.join(ctx.root,
    // "bin", ...). The bundled artifact ships them under dist/bin/, so the fixed
    // join was correct in the source tree and broken for every installer.
    bin: packageBin,
    paths,
    dispatchOperator,
    resolveOperator,
  };
}

export async function run(argv = []) {
  const version = readPackageVersion();

  if (argv.includes("--version") || argv.includes("-V")) {
    return runVersion();
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    const commands = await discoverCommands();
    process.stdout.write(renderHelp(version, commands));
    return 0;
  }

  if (argv.length === 0) {
    const commands = await discoverCommands();
    if (shouldLaunchChat(argv)) {
      const chat = commands.get("chat");
      if (chat) return chat.run(buildCtx([]));
    }
    process.stdout.write(renderHelp(version, commands));
    return 0;
  }

  if (isRootChatFlag(argv[0])) {
    const commands = await discoverCommands();
    const chat = commands.get("chat");
    if (chat) return chat.run(buildCtx(argv));
  }

  const noun = argv[0];
  const rest = argv.slice(1);

  if (noun === "version") {
    return runVersion();
  }
  if (noun === "help") {
    const commands = await discoverCommands();
    if (rest[0]) {
      const cmd = commands.get(rest[0]);
      if (cmd) {
        process.stdout.write((cmd.usage || `oracle ${cmd.name}`) + "\n");
        if (cmd.summary) process.stdout.write(cmd.summary + "\n");
        return 0;
      }
      process.stderr.write(unknownNounMessage(rest[0], commands));
      return 1;
    }
    process.stdout.write(renderHelp(version, commands));
    return 0;
  }

  const commands = await discoverCommands();
  const cmd = commands.get(noun);

  if (cmd) {
    if (rest[0] === "--help" || rest[0] === "-h") {
      process.stdout.write((cmd.usage || `oracle ${cmd.name}`) + "\n");
      if (cmd.summary) process.stdout.write(cmd.summary + "\n");
      return 0;
    }
    if (SIGN_NOUNS.includes(noun)) {
      try {
        const code = await cmd.run(buildCtx(rest));
        return typeof code === "number" ? code : 0;
      } catch (err) {
        process.stderr.write(`oracle ${noun}: ${err?.message || err}\n`);
        return 1;
      }
    }
    try {
      const code = await cmd.run(buildCtx(rest));
      return typeof code === "number" ? code : 0;
    } catch (err) {
      process.stderr.write(`oracle ${noun}: ${err?.message || err}\n`);
      return 1;
    }
  }

  if (SIGN_NOUNS.includes(noun)) {
    const resolved = resolveOperator();
    if (!resolved.ok) {
      printOperatorNotInstalled(process.stderr);
      return 3;
    }
    process.stderr.write(
      `oracle: sign-plane command '${noun}' is not available in this build (operator is installed).\n`,
    );
    return 1;
  }

  process.stderr.write(unknownNounMessage(noun, commands));
  return 1;
}

async function runVersion() {
  const version = readPackageVersion();
  let line = `oracle ${version}`;
  const op = resolveOperator();
  if (op.ok) {
    line += `  operator ${op.version}`;
  }
  process.stdout.write(line + "\n");
  return 0;
}

export default { run, discoverCommands, renderHelp };

export function shouldLaunchChat(
  argv = [],
  io = { stdin: process.stdin, stdout: process.stdout },
) {
  if (argv.length !== 0) return false;
  if (process.env.ORACLE_FORCE_CHAT === "1") return true;
  return io.stdin?.isTTY === true && io.stdout?.isTTY === true;
}

export function isRootChatFlag(value) {
  return [
    "-m", "--model", "--provider", "-q", "--query", "-Q", "--quiet",
    "-c", "--continue", "-r", "--resume", "-s", "--skills", "-t",
    "--toolsets", "--reasoning", "--tui", "--cli", "--yolo",
    "--checkpoints", "--source", "--max-turns",
  ].includes(String(value || ""));
}
