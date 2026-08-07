import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findWorkingChain,
  listWorkingChains,
  renderChainList,
} from "../src/cli/chain-catalog.mjs";
import {
  clearActiveChain,
  readActiveChain,
  writeActiveChain,
} from "../src/cli/chain-state.mjs";
import {
  findMessagingPlatform,
  listMessagingPlatforms,
  renderSetupMenu,
} from "../src/cli/messaging-platforms.mjs";
import {
  parseDotEnv,
  platformStatus,
  setPlatformToken,
  writeProfileEnvKey,
} from "../src/cli/setup-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");

function runOracle(args, env = {}) {
  return spawnSync(process.execPath, [ORACLE, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-chat-"));
}

test("working chain catalog includes hyperliquid and non-evm surfaces", () => {
  const keys = listWorkingChains().map((c) => c.key);
  for (const k of ["hyperliquid", "base", "solana", "bitcoin", "robinhood", "polymarket"]) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  const hl = findWorkingChain("hl");
  assert.equal(hl.key, "hyperliquid");
  assert.equal(hl.chainId, 999);
  assert.equal(findWorkingChain("999").key, "hyperliquid");
  assert.equal(findWorkingChain("sol").key, "solana");
  assert.equal(findWorkingChain("eth").key, "ethereum");
  assert.equal(findWorkingChain("eth").chainId, 1);
});

test("renderChainList is lowercase and documents /chain", () => {
  const text = renderChainList({ selectedKey: "hyperliquid" });
  assert.match(text, /oracle chains/);
  assert.match(text, /\* hyperliquid/);
  assert.match(text, /\/chain hyperliquid/);
  assert.doesNotMatch(text, /ORACLE CHAINS/);
});

test("active chain persists under fake home", () => {
  const home = tempHome();
  const env = { ORACLE_FAKE_HOME: home };
  // direct module path uses process.env via paths.homeDir
  process.env.ORACLE_FAKE_HOME = home;
  try {
    clearActiveChain();
    assert.equal(readActiveChain(), null);
    const active = writeActiveChain("hyperliquid");
    assert.equal(active.key, "hyperliquid");
    assert.equal(readActiveChain().chainId, 999);
    const r = runOracle(["chain", "show"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hyperliquid/);
    const list = runOracle(["chain", "list"], env);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /solana/);
    const eth = runOracle(["chain", "eth"], env);
    assert.equal(eth.status, 0, eth.stderr);
    assert.match(eth.stdout, /selected ethereum \(1\)/);
    assert.equal(readActiveChain().key, "ethereum");
    const bad = runOracle(["chain", "use", "not-a-chain"], env);
    assert.equal(bad.status, 1);
    runOracle(["chain", "clear"], env);
    assert.equal(readActiveChain(), null);
  } finally {
    delete process.env.ORACLE_FAKE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("messaging platform menu covers telegram and discord", () => {
  const keys = listMessagingPlatforms().map((p) => p.key);
  for (const k of ["telegram", "discord", "slack", "whatsapp", "signal", "matrix"]) {
    assert.ok(keys.includes(k), `missing platform ${k}`);
  }
  assert.equal(findMessagingPlatform("telegram").required[0], "TELEGRAM_BOT_TOKEN");
  const menu = renderSetupMenu({ profile: "oracle", statuses: { telegram: "ready" } });
  assert.match(menu, /oracle setup/);
  assert.match(menu, /telegram/);
  assert.match(menu, /discord/);
  assert.match(menu, /tokens stay in the hermes profile/);
});

test("setup writes tokens to profile env without echoing secrets", () => {
  const home = tempHome();
  process.env.ORACLE_FAKE_HOME = home;
  process.env.HERMES_HOME = path.join(home, ".hermes");
  try {
    const profile = "oracle";
    const profileDir = path.join(home, ".hermes", "profiles", profile);
    fs.mkdirSync(profileDir, { recursive: true });
    const result = setPlatformToken(profile, "telegram", "123456:ABCDEF-test-token-value-xxxxx", {
      TELEGRAM_ALLOWED_USERS: "1426127634",
    });
    assert.equal(result.platform, "telegram");
    const envText = fs.readFileSync(result.path, "utf8");
    assert.match(envText, /TELEGRAM_BOT_TOKEN=123456:ABCDEF-test-token-value-xxxxx/);
    assert.match(envText, /TELEGRAM_ALLOWED_USERS=1426127634/);
    const st = platformStatus(profile);
    assert.equal(st.statuses.telegram, "ready");
    const r = runOracle(["setup", "status", "--json", "--profile", profile], {
      ORACLE_FAKE_HOME: home,
      HERMES_HOME: path.join(home, ".hermes"),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /ABCDEF-test-token-value/);
    assert.match(r.stdout, /"telegram": "ready"/);
  } finally {
    delete process.env.ORACLE_FAKE_HOME;
    delete process.env.HERMES_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("messaging setup hides interactive token entry", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "cli", "commands", "setup.mjs"), "utf8");
  assert.match(source, /setRawMode\(true\)/);
  assert.match(source, /setRawMode\(false\)/);
  assert.doesNotMatch(source, /readline cannot hide input/i);
  assert.doesNotMatch(source, /rl\.question/);
});

test("parseDotEnv handles quotes and comments", () => {
  const env = parseDotEnv("# c\nFOO=bar\nBAZ=\"qux\"\n");
  assert.equal(env.FOO, "bar");
  assert.equal(env.BAZ, "qux");
});

test("oracle chat --print-banner is a filled oracle wordmark", () => {
  const r = runOracle(["chat", "--print-banner"], { COLUMNS: "100", PATH: process.env.PATH });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /██████  ████████   ██████/);
  assert.match(r.stdout, /░░██████  █████/);
  const mainLine = r.stdout.split(/\r?\n/).find((line) => line.includes("██████  ████████"));
  assert.ok(mainLine.startsWith(" ".repeat(25)), JSON.stringify(mainLine));
  assert.doesNotMatch(r.stdout, /Hermes/);
});

test("oracle harness owns the filled boxed chat surface", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "cli", "oracle-harness.py"), "utf8");
  assert.match(source, /WORDMARK =/);
  assert.match(source, /THE FUTURE IS AGENTIC/);
  assert.match(source, /THE FUTURE IS AGENTIC  \/  by DEMI/);
  assert.match(source, /class:oracle-composer/);
  assert.match(source, /Frame\(/);
  assert.match(source, /"  oracle  › "/);
  assert.doesNotMatch(source, /Ask Oracle/);
  assert.doesNotMatch(source, /\/model   \/chain   \/setup/);
  assert.match(source, /VSplit/);
  assert.match(source, /voice_status_bar,\n\s+status_bar,/);
  assert.match(source, /_build_context_bar/);
  assert.match(source, /context_tokens/);
  assert.match(source, /context_length/);
  assert.match(source, /prompt_elapsed/);
  assert.match(source, /reasoning_config/);
  assert.match(source, /effort/);
  assert.match(source, /def _oracle_chain\(command\):/);
  assert.match(source, /ORACLE_NODE_BIN/);
  assert.match(source, /ORACLE_CLI_ENTRY/);
  assert.match(source, /\[node, entry, "chain", \*args\]/);
  assert.match(source, /subprocess\.run\(/);
  assert.match(source, /ORACLE_ACTIVE_CHAIN/);
  assert.match(source, /def pad_for\(ink_width, ink_offset=0\):/);
  assert.match(source, /int\(round\(\(width - ink_width\) \/ 2\.0\)\)/);
  assert.match(source, /ink_cols = \[/);
  assert.doesNotMatch(source, /Text\(justify="center"\)/);
  assert.doesNotMatch(source, /Group\(Align\.center\(body\)\)/);
  assert.match(source, /os\.environ\.pop\("ORACLE_ACTIVE_CHAIN", None\)/);
  assert.match(source, /parts = command\.strip\(\)\.lower\(\)\.split\(maxsplit=1\)/);
  assert.match(source, /if parts and parts\[0\] == "\/chain":/);
  assert.match(source, /process_command/);
  assert.doesNotMatch(source, /body\.append\(line\.rstrip\(\)/);
  assert.doesNotMatch(source, /_scrollback_box_width/);
  assert.doesNotMatch(source, /premium_cprint/);
});

test("oracle harness renders context, effort, and thinking metrics", () => {
  const script = String.raw`
import importlib.util
import os
import types

spec = importlib.util.spec_from_file_location("oracle_harness", "src/cli/oracle-harness.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)

assert len(harness.WORDMARK) == 6
assert set(map(len, harness.WORDMARK)) == {58}
assert [len(line) - len(line.lstrip()) for line in harness.WORDMARK] == [4, 3, 3, 3, 3, 4]
assert harness.WORDMARK[0].strip().startswith("██████  ████████")
assert any("░" in line for line in harness.WORDMARK)

class StubCLI:
    def process_command(self, command):
        return False

    def _get_status_bar_snapshot(self):
        return {
            "model_short": "gpt-5.5",
            "context_tokens": 64000,
            "context_length": 200000,
            "context_percent": 32,
            "prompt_elapsed": "⏱ 12s",
        }

    def _get_tui_terminal_width(self):
        return 100

    def _build_context_bar(self, percent, width=8):
        filled = round(((percent or 0) / 100) * width)
        return "[" + ("█" * filled) + ("░" * (width - filled)) + "]"

module = types.SimpleNamespace(HermesCLI=StubCLI, _cprint=print)
harness.patch_cli(module)
cli = StubCLI()
cli.reasoning_config = {"enabled": True, "effort": "xhigh"}
os.environ["ORACLE_ACTIVE_CHAIN"] = "hyperliquid"
with_chain = "".join(text for _, text in cli._get_status_bar_fragments())
assert with_chain.endswith("/ hyperliquid  ")
os.environ.pop("ORACLE_ACTIVE_CHAIN")
without_chain = "".join(text for _, text in cli._get_status_bar_fragments())
assert "hyperliquid" not in without_chain
print(with_chain)
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^  oracle \/ gpt-5\.5 \/ ctx/m);
  assert.doesNotMatch(result.stdout, /\/ by DEMI \/ ctx/);
  assert.match(result.stdout, /ctx \[███░░░░░\] 64K\/200K 32%/);
  assert.match(result.stdout, /\/ xhigh \/ 12s/);
  assert.match(result.stdout, /\/ 12s \/ hyperliquid/);
  assert.doesNotMatch(result.stdout, /effort|think/);
  assert.doesNotMatch(result.stdout.trim(), /\n/);
});

test("oracle chat launches plain harness when hermes is a python entrypoint", () => {
  const home = tempHome();
  const hermesRoot = path.join(home, ".hermes");
  const profileDir = path.join(hermesRoot, "profiles", "oracle");
  const log = path.join(home, "harness.log");
  const fakePy = path.join(home, "python");
  const fakeHermes = path.join(home, "hermes");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "config.yaml"), "model:\n  default: test\n");
  fs.writeFileSync(
    fakePy,
    `#!/bin/sh\nprintf 'PY=%s\\n' "$*" >> "$ORACLE_TEST_LOG"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(fakeHermes, `#!${fakePy}\n`, { mode: 0o755 });
  try {
    const r = runOracle(["chat", "-Q"], {
      ORACLE_FAKE_HOME: home,
      HERMES_HOME: hermesRoot,
      ORACLE_HERMES_BIN: fakeHermes,
      ORACLE_TEST_LOG: log,
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /oracle-harness\.py/);
    assert.match(calls, /-p oracle chat --quiet/);
    assert.equal(
      fs.readFileSync(path.join(profileDir, "SOUL.md"), "utf8"),
      fs.readFileSync(path.join(ROOT, "profiles", "oracle", "SOUL.md"), "utf8"),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ORACLE_PLAIN_HARNESS=0 keeps direct hermes launch", () => {
  const home = tempHome();
  const hermesRoot = path.join(home, ".hermes");
  const profileDir = path.join(hermesRoot, "profiles", "oracle");
  const log = path.join(home, "hermes.log");
  const fakeHermes = path.join(home, "hermes");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "config.yaml"), "model:\n  default: test\n");
  fs.writeFileSync(
    fakeHermes,
    `#!/bin/sh\nprintf 'ARGS=%s\\n' "$*" >> "$ORACLE_TEST_LOG"\n`,
    { mode: 0o755 },
  );
  try {
    const r = runOracle(["chat", "-Q"], {
      ORACLE_FAKE_HOME: home,
      HERMES_HOME: hermesRoot,
      ORACLE_HERMES_BIN: fakeHermes,
      ORACLE_TEST_LOG: log,
      ORACLE_PLAIN_HARNESS: "0",
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /ARGS=-p oracle chat --quiet/);
    assert.doesNotMatch(calls, /oracle-harness\.py/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle chat can route one-shot compute to Arch over SSH", () => {
  const home = tempHome();
  const binDir = path.join(home, "bin");
  const log = path.join(home, "ssh.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > "$ORACLE_TEST_LOG"\n`,
    { mode: 0o755 },
  );
  try {
    const env = {
      ORACLE_FAKE_HOME: home,
      ORACLE_TEST_LOG: log,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    };
    const saved = runOracle(["model", "--backend", "arch", "--compute-host", "arch-demi"], env);
    assert.equal(saved.status, 0, saved.stderr);
    const r = runOracle(["chat", "-q", "hello world", "--quiet"], env);
    assert.equal(r.status, 0, r.stderr);
    const call = fs.readFileSync(log, "utf8");
    assert.match(call, /BatchMode=yes/);
    assert.match(call, /ConnectTimeout=12/);
    assert.match(call, /arch-demi/);
    assert.match(call, /ORACLE_REMOTE_COMPUTE_DISABLE=1/);
    assert.match(call, /'oracle' 'chat' '-q' 'hello world' '--quiet'/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fresh non-tty chat stops at oracle model setup and installs the oracle persona", () => {
  const home = tempHome();
  const hermesRoot = path.join(home, ".hermes");
  const profileDir = path.join(hermesRoot, "profiles", "oracle");
  const log = path.join(home, "hermes.log");
  const fakeHermes = path.join(home, "hermes");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    fakeHermes,
    `#!/bin/sh\nprintf 'ARGS=%s\\n' "$*" >> "$ORACLE_TEST_LOG"\n`,
    { mode: 0o755 },
  );
  try {
    const r = runOracle(["chat", "-q", "hello"], {
      ORACLE_FAKE_HOME: home,
      HERMES_HOME: hermesRoot,
      ORACLE_HERMES_BIN: fakeHermes,
      ORACLE_TEST_LOG: log,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /oracle chat needs a configured model/);
    assert.match(r.stderr, /run: oracle model/);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /chat/);
    assert.equal(
      fs.readFileSync(path.join(profileDir, "SOUL.md"), "utf8"),
      fs.readFileSync(path.join(ROOT, "profiles", "oracle", "SOUL.md"), "utf8"),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle --help advertises chat chain setup", () => {
  const r = runOracle(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /oracle chat/);
  assert.match(r.stdout, /oracle chain/);
  assert.match(r.stdout, /oracle setup/);
  assert.match(r.stdout, /oracle model/);
});

test("writeProfileEnvKey rejects bad keys", () => {
  const home = tempHome();
  process.env.ORACLE_FAKE_HOME = home;
  process.env.HERMES_HOME = path.join(home, ".hermes");
  try {
    fs.mkdirSync(path.join(home, ".hermes", "profiles", "oracle"), { recursive: true });
    assert.throws(() => writeProfileEnvKey("oracle", "bad-key", "x"), /invalid env key/);
  } finally {
    delete process.env.ORACLE_FAKE_HOME;
    delete process.env.HERMES_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("bare oracle launches the oracle profile chat and forwards model flags", () => {
  const home = tempHome();
  const hermesRoot = path.join(home, ".hermes");
  const profileDir = path.join(hermesRoot, "profiles", "oracle");
  const log = path.join(home, "hermes.log");
  const fakeHermes = path.join(home, "hermes");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "config.yaml"), "model:\n  default: test\n");
  fs.writeFileSync(
    fakeHermes,
    "#!/bin/sh\nprintf 'ARGS=%s|PROFILE=%s|CHAIN=%s\\n' \"$*\" \"$ORACLE_PROFILE\" \"$ORACLE_ACTIVE_CHAIN\" >> \"$ORACLE_TEST_LOG\"\n",
    { mode: 0o755 },
  );
  try {
    const env = {
      ORACLE_FAKE_HOME: home,
      HERMES_HOME: hermesRoot,
      ORACLE_HERMES_BIN: fakeHermes,
      ORACLE_TEST_LOG: log,
      ORACLE_FORCE_CHAT: "1",
    };
    const bare = runOracle([], env);
    assert.equal(bare.status, 0, bare.stderr);
    let calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /ARGS=-p oracle chat\|PROFILE=oracle/);

    const picked = runOracle(["-m", "provider\/model"], env);
    assert.equal(picked.status, 0, picked.stderr);
    calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /ARGS=-p oracle chat --model provider\/model/);

    const model = runOracle(["model", "--refresh"], env);
    assert.equal(model.status, 0, model.stderr);
    calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /ARGS=-p oracle model --refresh/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
