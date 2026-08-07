import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import {
  findMessagingPlatform,
  listMessagingPlatforms,
  renderSetupMenu,
} from "../messaging-platforms.mjs";
import {
  platformStatus,
  renderStatus,
  setPlatformToken,
  touchSetupState,
} from "../setup-state.mjs";
import { hermesRoot } from "../paths.mjs";
import { installManagedHermes, resolveHermes } from "../runtime.mjs";

function usage() {
  return [
    "oracle setup — wire messaging + local agent surface",
    "",
    "  oracle setup                      menu + platform status",
    "  oracle setup status               same, machine-friendly with --json",
    "  oracle setup messaging            open hermes gateway setup wizard",
    "  oracle setup telegram             set TELEGRAM_BOT_TOKEN for profile",
    "  oracle setup discord              set DISCORD_BOT_TOKEN for profile",
    "  oracle setup slack                set slack tokens",
    "  oracle setup <platform>           any supported hermes platform",
    "  oracle setup gateway [status|restart|start|stop]",
    "  oracle setup profile [name]       default: oracle",
    "",
    "chat:",
    "  /setup",
    "  /setup telegram",
    "  /setup status",
    "",
    "tokens stay local in ~/.hermes/profiles/<profile>/.env",
    "oracle never prints secrets.",
  ].join("\n");
}

function profileFromArgs(args) {
  const i = args.indexOf("--profile");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const j = args.indexOf("-p");
  if (j >= 0 && args[j + 1]) return args[j + 1];
  return process.env.ORACLE_PROFILE || "oracle";
}

function stripProfileArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" || args[i] === "-p") {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function runHermes(argv, { inherit = true, env = process.env } = {}) {
  let resolved = resolveHermes();
  if (!resolved.ok && process.stdin.isTTY && process.stdout.isTTY && process.env.ORACLE_NO_BOOTSTRAP !== "1") {
    process.stdout.write("setting up oracle's local messaging runtime (one time)\n\n");
    const installed = installManagedHermes();
    if (installed.ok) resolved = { ok: true, bin: installed.bin };
  }
  if (!resolved.ok) {
    process.stderr.write("oracle setup needs the local runtime\nrun: oracle bootstrap\n");
    return 1;
  }
  const r = spawnSync(resolved.bin, argv, {
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
    env,
  });
  if (r.error) {
    process.stderr.write(`oracle setup: failed to run hermes: ${r.error.message}\n`);
    return 1;
  }
  if (!inherit) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  return typeof r.status === "number" ? r.status : 1;
}

async function promptSecret(label) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const err = new Error("interactive token entry requires a tty");
    err.code = "NO_TTY";
    throw err;
  }
  output.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function configurePlatform(profile, platformKey, inlineArgs = []) {
  const platform = findMessagingPlatform(platformKey);
  if (!platform) {
    process.stderr.write(`oracle setup: unknown platform '${platformKey}'\n`);
    process.stderr.write(
      `known: ${listMessagingPlatforms()
        .map((p) => p.key)
        .join(", ")}\n`,
    );
    return 1;
  }

  // Platforms without simple token keys go through Hermes interactive setup.
  if (!platform.required.length) {
    process.stdout.write(
      `opening hermes setup for ${platform.key} (interactive)\n`,
    );
    touchSetupState({ lastPlatform: platform.key, profile });
    return runHermes(["-p", profile, ...(platform.hermes || ["gateway", "setup"])]);
  }

  const flags = {};
  const positionals = [];
  for (let i = 0; i < inlineArgs.length; i++) {
    const a = inlineArgs[i];
    if (a === "--token" && inlineArgs[i + 1]) {
      flags.token = inlineArgs[++i];
      continue;
    }
    if (a === "--allowed-users" && inlineArgs[i + 1]) {
      flags.allowedUsers = inlineArgs[++i];
      continue;
    }
    if (a === "--app-token" && inlineArgs[i + 1]) {
      flags.appToken = inlineArgs[++i];
      continue;
    }
    if (a.startsWith("-")) {
      process.stderr.write(`oracle setup: unknown flag ${a}\n`);
      return 1;
    }
    positionals.push(a);
  }

  let token = flags.token || positionals[0] || "";
  if (!token) {
    try {
      token = await promptSecret(`${platform.key} bot token`);
    } catch (err) {
      if (err?.code === "NO_TTY") {
        process.stderr.write(
          `oracle setup ${platform.key}: pass --token <value> in non-interactive mode\n`,
        );
        return 1;
      }
      throw err;
    }
  }
  if (!token) {
    process.stderr.write("aborted: empty token\n");
    return 1;
  }

  const extra = {};
  if (flags.allowedUsers) {
    if (platform.key === "telegram") extra.TELEGRAM_ALLOWED_USERS = flags.allowedUsers;
    if (platform.key === "discord") extra.DISCORD_ALLOWED_USERS = flags.allowedUsers;
    if (platform.key === "slack") extra.SLACK_ALLOWED_USERS = flags.allowedUsers;
  }
  if (flags.appToken && platform.key === "slack") {
    extra.SLACK_APP_TOKEN = flags.appToken;
  }

  // Slack needs two tokens.
  if (platform.key === "slack" && !extra.SLACK_APP_TOKEN) {
    let app = flags.appToken || positionals[1] || "";
    if (!app && process.stdin.isTTY) {
      app = await promptSecret("slack app token (xapp-...)");
    }
    if (!app) {
      process.stderr.write("slack needs bot token + app token\n");
      return 1;
    }
    extra.SLACK_APP_TOKEN = app;
  }

  try {
    const result = setPlatformToken(profile, platform.key, token, extra);
    touchSetupState({ lastPlatform: platform.key, profile, ready: true });
    process.stdout.write(
      `saved ${platform.key} credentials for profile '${profile}'\n` +
        `path: ${result.path}\n` +
        `next: oracle setup gateway restart\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`oracle setup: ${err.message}\n`);
    return 1;
  }
}

export default {
  name: "setup",
  summary: "configure telegram/discord/slack messaging platforms",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = [...ctx.argv];
    const json = args.includes("--json");
    const profile = profileFromArgs(args);
    const clean = stripProfileArgs(args).filter((a) => a !== "--json");
    const verb = (clean[0] || "menu").toLowerCase();
    const rest = clean.slice(1);

    if (["-h", "--help", "help"].includes(verb)) {
      process.stdout.write(usage() + "\n");
      return 0;
    }

    if (["menu", "list", "ls"].includes(verb)) {
      if (json) {
        process.stdout.write(JSON.stringify(platformStatus(profile), null, 2) + "\n");
      } else {
        process.stdout.write(renderStatus(profile));
      }
      return 0;
    }

    if (["status", "show"].includes(verb)) {
      const st = platformStatus(profile);
      if (json) {
        process.stdout.write(JSON.stringify(st, null, 2) + "\n");
      } else {
        process.stdout.write(renderStatus(profile));
        process.stdout.write(`hermes root: ${hermesRoot()}\n`);
      }
      return 0;
    }

    if (["messaging", "gateway-setup", "platforms"].includes(verb)) {
      touchSetupState({ lastAction: "messaging", profile });
      process.stdout.write("opening hermes gateway setup wizard...\n");
      return runHermes(["-p", profile, "gateway", "setup"]);
    }

    if (verb === "gateway") {
      const action = (rest[0] || "status").toLowerCase();
      if (!["status", "start", "stop", "restart", "run", "install"].includes(action)) {
        process.stderr.write("usage: oracle setup gateway [status|start|stop|restart|run|install]\n");
        return 1;
      }
      return runHermes(["-p", profile, "gateway", action]);
    }

    if (verb === "profile") {
      const name = rest[0] || profile;
      process.stdout.write(`profile: ${name}\nhermes: ${hermesRoot()}/profiles/${name}\n`);
      process.stdout.write(renderStatus(name));
      return 0;
    }

    // oracle setup telegram|discord|...
    if (findMessagingPlatform(verb)) {
      return configurePlatform(profile, verb, rest);
    }

    process.stderr.write(`oracle setup: unknown verb '${verb}'\n${usage()}\n`);
    return 1;
  },
};
