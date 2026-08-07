// Every advertised binary must actually run.
//
// Direct regression: bin/oracle-data-mcp.mjs shipped as a one-line shim importing
// bin/mad-data-mcp.mjs -- a file that was never extracted. The advertised MCP entry
// point, the whole way an agent reaches Oracle, crashed with ERR_MODULE_NOT_FOUND on
// startup. 481 tests were green because nothing ever executed it.
//
// The import-closure walker missed it too: it followed imports it could RESOLVE, and
// an unresolvable target silently produced no edge instead of an error. So this test
// exists to check the crudest property there is -- does the thing start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("every bin entry in package.json exists on disk", async () => {
  const missing = [];
  for (const [name, rel] of Object.entries(pkg.bin || {})) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${name} -> ${rel}`);
  }
  assert.deepEqual(missing, [], `package.json advertises binaries that do not exist:\n  ${missing.join("\n  ")}`);

  assert.equal(pkg.bin?.oracle, "./bin/oracle.mjs", "the package must advertise the bare oracle command");
  const { COMMANDS } = await import("../bin/oracle.mjs");
  assert.deepEqual(COMMANDS, {
    data: "./desk-server.mjs",
    public: "./oracle-public-server.mjs",
    "data-mcp": "./oracle-data-mcp.mjs",
    init: "./oracle-init.mjs",
    upgrade: "./oracle-upgrade.mjs",
    scan: "./oracle-scan.mjs",
    route: "./oracle-route.mjs",
    equities: "./oracle-equities.mjs",
  });
  assert.equal(Object.isFrozen(COMMANDS), true, "the root verb map must not be mutable");
});

test("every bin entry parses AND its import graph fully resolves", () => {
  // `node --check` only parses -- it cannot see a missing import target, because
  // resolution happens at run time. Verified: with the original broken shim in place,
  // --check passed happily while the binary crashed on startup.
  //
  // So walk each binary's relative imports transitively and assert every target
  // exists. This catches the broken-shim class of bug at the file level, without
  // needing to execute anything.
  const broken = [];

  const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["'](\.[^"']+)["']/g;
  const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g;

  const walk = (file, seen, originName) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const target = path.resolve(path.dirname(file), m[1]);
        if (!fs.existsSync(target)) {
          broken.push(
            `${originName}: ${path.relative(ROOT, file)} imports "${m[1]}" which does not exist`,
          );
          continue;
        }
        walk(target, seen, originName);
      }
    }
  };

  for (const [name, rel] of Object.entries(pkg.bin || {})) {
    const abs = path.join(ROOT, rel);
    try {
      execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
    } catch (e) {
      broken.push(`${name}: syntax error -- ${String(e.stderr || e).slice(0, 200)}`);
      continue;
    }
    walk(abs, new Set(), name);
  }

  const rootSource = fs.readFileSync(path.join(ROOT, "bin", "oracle.mjs"), "utf8");
  assert.doesNotMatch(
    rootSource,
    /@oracle-agent\/operator|src\/public-control\/|src\/router\//,
    "the root dispatcher must not import Operator or Oracle business logic",
  );

  assert.deepEqual(broken, [], `unresolvable imports reachable from a shipped binary:\n  ${broken.join("\n  ")}`);
});

test("CLI binaries print usage instead of crashing when run with no args", async () => {
  // A CLI that throws on bare invocation cannot be discovered by a new user.
  const clis = ["oracle", "oracle-init", "oracle-scan", "oracle-route", "oracle-equities"];
  const failures = [];

  for (const name of clis) {
    const rel = pkg.bin?.[name];
    if (!rel) {
      failures.push(`${name} is not in package.json bin`);
      continue;
    }
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, rel)], {
        stdio: "pipe",
        timeout: 30_000,
        encoding: "utf8",
      });
      if (!/usage|oracle(?:\s|—|-)/i.test(out)) failures.push(`${name}: no usage text in output`);
    } catch (e) {
      // A non-zero exit is fine for a bare CLI; a module-resolution crash is not.
      const combined = `${e.stdout || ""}${e.stderr || ""}`;
      if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(combined)) {
        failures.push(`${name}: BROKEN IMPORT -- ${combined.slice(0, 200)}`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));

  const rootCli = path.join(ROOT, pkg.bin.oracle);
  const rootHelp = spawnSync(process.execPath, [rootCli], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(rootHelp.status, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /self-custody multichain agent control plane/);

  for (const args of [["not-an-oracle-verb"], ["toString"]]) {
    const result = spawnSync(process.execPath, [rootCli, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1, `oracle ${args.join(" ")} must reject unknown verbs`);
    assert.match(`${result.stdout}${result.stderr}`, /unknown command/);
  }

  const representative = spawnSync(process.execPath, [rootCli, "scan", "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(representative.status, 0, representative.stderr);
  assert.match(representative.stdout, /oracle scan/);

  const rejectedChild = spawnSync(process.execPath, [rootCli, "scan", "not-a-scan-command"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(rejectedChild.status, 1, "the root command must propagate a child exit code");

  if (process.platform !== "win32") {
    const signaled = spawn(process.execPath, [rootCli, "data-mcp"], {
      cwd: ROOT,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(signaled.kill("SIGTERM"), true, "the representative child must still be running");
    const closed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-signaled.pid, "SIGKILL");
        } catch {
          // It may have exited between the timeout firing and cleanup.
        }
        reject(new Error("oracle did not forward SIGTERM and close its child process"));
      }, 4_000);
      signaled.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(closed.code, null);
    assert.equal(closed.signal, "SIGTERM", "the root command must propagate the child signal");
  }
});

test("the MCP server completes a real initialize + tools/list handshake", async () => {
  // The contract that matters for an agent: speak JSON-RPC over stdio and advertise
  // tools. Anything less and Oracle is shell-only in practice.
  const rel = pkg.bin?.["oracle-data-mcp"];
  assert.ok(rel, "oracle-data-mcp must be advertised");

  const proc = spawn(process.execPath, [path.join(ROOT, rel)], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  proc.stdout.on("data", (d) => {
    for (const l of String(d).split("\n")) if (l.trim()) lines.push(l.trim());
  });

  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  // Give it a moment to answer, then stop. No network is involved in either call.
  await new Promise((r) => setTimeout(r, 2_500));
  proc.kill();

  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const init = parsed.find((m) => m.id === 1);
  assert.ok(init?.result, `initialize did not return a result. stdout: ${lines.join(" | ").slice(0, 300)}`);
  assert.equal(init.result.serverInfo?.name, "oracle-data-mcp", "server must identify as Oracle, not a legacy name");

  const list = parsed.find((m) => m.id === 2);
  assert.ok(Array.isArray(list?.result?.tools), "tools/list must return a tools array");
  assert.ok(list.result.tools.length >= 20, `expected a substantial tool surface, got ${list.result.tools.length}`);

  // The routing tools are the reason this pass exists -- an agent must be able to
  // reach best-execution, not just a human at a shell.
  const names = list.result.tools.map((t) => t.name);
  for (const required of ["best_swap_route", "best_bridge_route"]) {
    assert.ok(names.includes(required), `${required} must be exposed over MCP`);
  }

  // Schemas must declare their required args, or an agent has to guess.
  for (const t of list.result.tools) {
    assert.ok(t.description?.length > 10, `${t.name} needs a usable description`);
    assert.equal(typeof t.inputSchema, "object", `${t.name} needs an inputSchema`);
  }
});

test("the MCP server starts through an npm-style bin symlink", async () => {
  // npm bin entries are symlinks. The old main-module check compared
  // import.meta.url to argv[1] as strings and exited before the stdio loop,
  // so `npx oracle-data-mcp` and Hermes --command oracle-data-mcp hung closed.
  const rel = pkg.bin?.["oracle-data-mcp"];
  assert.ok(rel, "oracle-data-mcp must be advertised");
  const real = path.join(ROOT, rel);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-mcp-bin-"));
  const link = path.join(tmp, "oracle-data-mcp");
  try {
    fs.symlinkSync(real, link);
    const proc = spawn(link, [], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = [];
    proc.stdout.on("data", (d) => {
      for (const l of String(d).split("\n")) if (l.trim()) lines.push(l.trim());
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    await new Promise((r) => setTimeout(r, 2_500));
    proc.kill();
    const parsed = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const init = parsed.find((m) => m.id === 1);
    assert.ok(
      init?.result,
      `symlink invoke must answer initialize. stdout: ${lines.join(" | ").slice(0, 300)}`,
    );
    assert.equal(init.result.serverInfo?.name, "oracle-data-mcp");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
