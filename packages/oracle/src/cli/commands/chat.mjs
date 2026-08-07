import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PACKAGE_ROOT, hermesRoot, ensureDir } from "../paths.mjs";
import { activeChainEnv } from "../chain-state.mjs";
import { readModelConfig } from "../model-config.mjs";
import { spawnChild } from "../spawn-child.mjs";
import { resolveHermes } from "../runtime.mjs";
import { runOracleTui } from "../../tui/app.mjs";
import { resolveChatBackend } from "../../tui/backend.mjs";
import { createStandaloneClient, runStandaloneQuery } from "../../tui/standalone-client.mjs";
import { getOAuthStore } from "../../auth/oauth.mjs";

const PROFILE = "oracle";
const SKIN_NAME = "oracle";

function which(bin) {
  if (bin === "hermes") {
    const r = resolveHermes();
    return r.ok ? r.bin : null;
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const c = path.join(dir, bin);
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function pythonShebang(file) {
  try {
    const first = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0];
    if (!first.startsWith("#!")) return null;
    const parts = first.slice(2).trim().split(/\s+/);
    if (parts[0]?.endsWith("/env") && parts[1]?.startsWith("python")) {
      return { command: parts[0], prefix: [parts[1]] };
    }
    if (path.basename(parts[0] || "").startsWith("python")) {
      return { command: parts[0], prefix: parts.slice(1) };
    }
  } catch {}
  return null;
}

export function resolveHermesPython(hermes) {
  const direct = pythonShebang(hermes);
  if (direct) return direct;
  try {
    const body = fs.readFileSync(hermes, "utf8");
    const match = body.match(/["']([^"'\r\n]+\/bin\/hermes)["']/);
    if (match) return pythonShebang(match[1]);
  } catch {}
  return null;
}

export function harnessSourcePath() {
  return path.join(PACKAGE_ROOT, "src", "cli", "oracle-harness.py");
}

export function oracleHarnessInvocation(hermes, args) {
  const harness = harnessSourcePath();
  const runtime = process.env.ORACLE_PLAIN_HARNESS === "0"
    ? null
    : resolveHermesPython(hermes);
  if (runtime && fs.existsSync(harness)) {
    return {
      command: runtime.command,
      args: [...runtime.prefix, harness, ...args],
    };
  }
  return { command: hermes, args };
}

function skinSourcePath() {
  return path.join(PACKAGE_ROOT, "skins", "oracle.yaml");
}

function ensureOracleProfile(profile = PROFILE) {
  const src = path.join(PACKAGE_ROOT, "profiles", "oracle", "SOUL.md");
  if (!fs.existsSync(src)) return { ok: false, reason: "oracle persona missing from package" };
  const dest = path.join(hermesRoot(), "profiles", profile, "SOUL.md");
  if (fs.existsSync(dest)) {
    const current = fs.readFileSync(dest, "utf8");
    if (!current.startsWith("You are Hermes Agent, an intelligent AI assistant created by Nous Research.")) {
      return { ok: true, reused: true };
    }
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return { ok: true, reused: false };
}

function ensureOracleSkin(profile = PROFILE) {
  const src = skinSourcePath();
  if (!fs.existsSync(src)) return { ok: false, reason: "skin missing from package" };
  const rootSkins = path.join(hermesRoot(), "skins");
  const profileSkins = path.join(hermesRoot(), "profiles", profile, "skins");
  ensureDir(rootSkins);
  ensureDir(profileSkins);
  const body = fs.readFileSync(src, "utf8");
  fs.writeFileSync(path.join(rootSkins, `${SKIN_NAME}.yaml`), body);
  fs.writeFileSync(path.join(profileSkins, `${SKIN_NAME}.yaml`), body);
  return { ok: true, skin: SKIN_NAME };
}

function ensureQuickCommands(profile = PROFILE) {
  // Install /chain and /setup as hermes quick commands that call oracle.
  const cfgPath = path.join(hermesRoot(), "profiles", profile, "config.yaml");
  if (!fs.existsSync(cfgPath)) return { ok: false, reason: "profile config missing" };

  // Prefer a tiny sidecar json the chat skill can also read; hermes quick_commands
  // live in config.yaml which we must not corrupt with naive YAML mutation.
  // We install a hermes-facing skill command instead (see skills/oracle-chat).
  const oracleBin = which("oracle") || path.join(PACKAGE_ROOT, "bin", "oracle.mjs");
  const markerDir = path.join(hermesRoot(), "profiles", profile, "oracle");
  ensureDir(markerDir);
  const marker = {
    profile,
    skin: SKIN_NAME,
    oracleBin,
    commands: {
      chain: [oracleBin, "chain"],
      setup: [oracleBin, "setup"],
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(markerDir, "chat-surface.json"),
    JSON.stringify(marker, null, 2) + "\n",
    { mode: 0o600 },
  );
  return { ok: true, marker };
}

function ensureSkillCommands(profile = PROFILE) {
  const srcDir = path.join(PACKAGE_ROOT, "skills", "oracle-chat");
  if (!fs.existsSync(srcDir)) return { ok: false, reason: "oracle-chat skill missing" };
  const destRoot = path.join(hermesRoot(), "profiles", profile, "skills", "oracle-chat");
  ensureDir(destRoot);
  for (const name of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(destRoot, name);
    if (fs.statSync(from).isFile()) {
      fs.copyFileSync(from, to);
    }
  }
  // Also install under profile skills root aliases for /chain and /setup.
  for (const slug of ["chain", "setup"]) {
    const aliasDir = path.join(hermesRoot(), "profiles", profile, "skills", slug);
    ensureDir(aliasDir);
    const skillMd = path.join(srcDir, `${slug}.SKILL.md`);
    const fallback = path.join(srcDir, "SKILL.md");
    const body = fs.existsSync(skillMd)
      ? fs.readFileSync(skillMd, "utf8")
      : fs.readFileSync(fallback, "utf8");
    fs.writeFileSync(path.join(aliasDir, "SKILL.md"), body);
  }
  return { ok: true };
}

function setDisplaySkin(profile = PROFILE) {
  const hermes = which("hermes");
  if (!hermes) return { ok: false, reason: "hermes missing" };
  // hermes config set is safe; avoids hand-editing yaml.
  const r = spawnSync(
    hermes,
    ["-p", profile, "config", "set", "display.skin", SKIN_NAME],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0) {
    return {
      ok: false,
      reason: (r.stderr || r.stdout || "config set failed").trim(),
    };
  }
  return { ok: true };
}

function hasModelConfig(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  if (/^model:\s*\S+/m.test(text)) return true;
  const block = text.match(/^model:\s*\n((?:[ \t]+.*(?:\n|$))*)/m)?.[1] || "";
  return /^\s+(?:default|provider):\s*\S+/m.test(block);
}

function hasProviderCredentials(profile = PROFILE) {
  const root = hermesRoot();
  if (fs.existsSync(path.join(root, "auth.json"))) return true;
  if (fs.existsSync(path.join(root, "profiles", profile, "auth.json"))) return true;
  const keys = [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "HF_TOKEN",
    "GLM_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
  ];
  if (keys.some((key) => process.env[key])) return true;
  for (const file of [path.join(root, ".env"), path.join(root, "profiles", profile, ".env")]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (keys.some((key) => new RegExp(`^${key}=.+`, "m").test(text))) return true;
  }
  return false;
}

function modelReady(profile = PROFILE) {
  const root = hermesRoot();
  return (
    hasModelConfig(path.join(root, "config.yaml")) ||
    hasModelConfig(path.join(root, "profiles", profile, "config.yaml")) ||
    hasProviderCredentials(profile)
  );
}

function usage() {
  return [
    "oracle chat, filled lowercase oracle chat",
    "",
    "  oracle chat                 open interactive oracle chat",
    "  oracle chat -q \"...\"        one-shot query",
    "  oracle chat --model <m>     use a model for this session",
    "  oracle chat --print-banner  show filled oracle banner only",
    "",
    "inside chat:",
    "  /chain                      list/select chains",
    "  /setup                      messaging setup menu",
    "  /model                      switch models (still one oracle persona)",
    "",
    "brand: filled lowercase oracle / classic boxed layout",
  ].join("\n");
}

function terminalColumns() {
  const columns = Number(process.stdout?.columns || process.env.COLUMNS || 80);
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
}

function visibleWidth(text) {
  return Array.from(String(text)).length;
}

function centerBlock(lines, width) {
  const clean = lines.map((line) => line.trimEnd());
  const blockWidth = Math.max(0, ...clean.map((line) => visibleWidth(line)));
  const left = Math.max(0, Math.floor((width - blockWidth) / 2));
  const pad = " ".repeat(left);
  return clean.map((line) => (line ? `${pad}${line}` : ""));
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function remoteTarget(config) {
  return config.user ? `${config.user}@${config.host}` : config.host;
}

function remoteOracleCommand(config, args) {
  const pathEnv = config.path || "$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";
  const argv = ["oracle", "chat", ...args].map(shQuote).join(" ");
  const pathAssignment = /^[A-Za-z0-9_:$/.~+-]+$/.test(pathEnv)
    ? `export PATH=${pathEnv}`
    : `export PATH=${shQuote(pathEnv)}`;
  return [
    pathAssignment,
    "export ORACLE_REMOTE_COMPUTE_DISABLE=1",
    "export ORACLE_CHAT_BACKEND=auto",
    argv,
  ].join("; ");
}

function printBanner() {
  const lines = [
    "",
    "                                       ████",
    "                                      ░░███",
    "  ██████  ████████   ██████    ██████  ░███   ██████",
    " ███░░███░░███░░███ ░░░░░███  ███░░███ ░███  ███░░███",
    "░███ ░███ ░███ ░░░   ███████ ░███ ░░░  ░███ ░███████",
    "░███ ░███ ░███      ███░░███ ░███  ███ ░███ ░███░░░",
    "░░██████  █████    ░░████████░░██████  █████░░██████",
    " ░░░░░░  ░░░░░      ░░░░░░░░  ░░░░░░  ░░░░░  ░░░░░░",
    "",
  ];
  process.stdout.write(centerBlock(lines, terminalColumns()).join("\n") + "\n");
}

function parseLaunchArgs(args) {
  const parsed = { pass: [], query: null, model: null, provider: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "--model" || arg === "-m") && args[i + 1]) {
      parsed.model = args[++i];
      parsed.pass.push("--model", parsed.model);
      continue;
    }
    if (arg === "--provider" && args[i + 1]) {
      parsed.provider = args[++i];
      parsed.pass.push("--provider", parsed.provider);
      continue;
    }
    if ((arg === "-q" || arg === "--query") && args[i + 1]) {
      parsed.query = args[++i];
      parsed.pass.push("-q", parsed.query);
      continue;
    }
    if (arg === "--quiet" || arg === "-Q") {
      parsed.pass.push("--quiet");
      continue;
    }
    if (arg === "--continue" || arg === "-c") {
      parsed.pass.push("--continue");
      continue;
    }
    parsed.pass.push(arg);
  }
  return parsed;
}

export default {
  name: "chat",
  summary: "open the one oracle chat surface (telegram-like, multi-model)",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = [...ctx.argv];
    if (args.includes("-h") || args.includes("--help")) {
      process.stdout.write(usage() + "\n");
      return 0;
    }
    if (args.includes("--print-banner")) {
      printBanner();
      return 0;
    }

    const parsed = parseLaunchArgs(args);
    const selectionEnv = {
      ...process.env,
      ...(parsed.model ? { ORACLE_MODEL: parsed.model } : {}),
      ...(parsed.provider ? { ORACLE_PROVIDER: parsed.provider } : {}),
    };
    const authStore = getOAuthStore();
    const backend = resolveChatBackend({
      env: selectionEnv,
      hermes: resolveHermes(),
      storedConfig: readModelConfig(),
      oauthAvailable: (provider) => Boolean(authStore.get(provider)),
      apiKeyResolver: (provider) => authStore.getApiKey(provider),
    });
    if (backend.kind === "unconfigured") {
      process.stderr.write(`${backend.reason}\n`);
      return 1;
    }

    if (backend.kind === "remote") {
      return spawnChild(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", remoteTarget(backend.config), remoteOracleCommand(backend.config, parsed.pass)],
        { stdio: "inherit", env: process.env },
        "oracle-remote-compute",
      );
    }

    const cleanEnv = activeChainEnv({
      ORACLE_CHAT_SURFACE: "1",
      ORACLE_PROFILE: PROFILE,
      ORACLE_NODE_BIN: process.execPath,
      ORACLE_CLI_ENTRY: path.join(PACKAGE_ROOT, "bin", "oracle.mjs"),
    });

    if (backend.kind === "standalone") {
      const client = createStandaloneClient({
        config: {
          ...backend.config,
          ...(parsed.model ? { model: parsed.model } : {}),
        },
      });
      if (parsed.query) {
        try {
          return await runStandaloneQuery({
            client,
            text: parsed.query,
            stdout: process.stdout,
            stderr: process.stderr,
          });
        } catch {
          return 1;
        }
      }
      const native = await runOracleTui({
        client,
        args,
        env: cleanEnv,
        cwd: process.cwd(),
        stdin: process.stdin,
        stdout: process.stdout,
      });
      if (native.native) return native.code;
      process.stderr.write(
        process.env.ORACLE_NATIVE_TUI === "0"
          ? "oracle standalone chat requires the native TUI; remove ORACLE_NATIVE_TUI=0\n"
          : "oracle standalone chat requires an interactive TTY or -q <query>\n",
      );
      return 1;
    }

    const hermes = backend.bin;
    ensureOracleProfile(PROFILE);
    ensureOracleSkin(PROFILE);
    ensureSkillCommands(PROFILE);
    const skinSet = setDisplaySkin(PROFILE);
    ensureQuickCommands(PROFILE);
    if (!skinSet.ok && process.env.ORACLE_CLI_DEBUG) {
      process.stderr.write(`oracle chat: skin note: ${skinSet.reason}\n`);
    }

    const explicitModel = Boolean(parsed.model || parsed.provider);
    if (!modelReady(PROFILE) && !explicitModel) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write("oracle chat needs a configured model\nrun: oracle model\n");
        return 1;
      }
      process.stdout.write("choose oracle's model before first chat\n\n");
      const modelLaunch = oracleHarnessInvocation(hermes, ["-p", PROFILE, "model"]);
      const selected = await spawnChild(
        modelLaunch.command,
        modelLaunch.args,
        { stdio: "inherit", env: process.env },
        "oracle-model",
      );
      if (selected !== 0 || !modelReady(PROFILE)) return selected || 1;
    }

    const hermesArgs = ["-p", PROFILE, "chat"];
    const hermesPython = resolveHermesPython(hermes);
    const native = await runOracleTui({
      hermesPython,
      args,
      env: cleanEnv,
      cwd: process.cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
    });
    if (native.native) return native.code;

    const launch = oracleHarnessInvocation(hermes, [...hermesArgs, ...parsed.pass]);
    return spawnChild(
      launch.command,
      launch.args,
      {
        stdio: "inherit",
        env: cleanEnv,
      },
      "oracle-chat",
    );
  },
};
