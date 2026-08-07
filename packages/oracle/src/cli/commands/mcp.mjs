import { parseArgs } from "node:util";
import { printOperatorNotInstalled } from "../operator-dispatch.mjs";
import { installClaudeCode } from "../mcp-targets/claude-code.mjs";
import { installClaudeDesktop } from "../mcp-targets/claude-desktop.mjs";
import { installCodex } from "../mcp-targets/codex.mjs";
import { installChatgpt } from "../mcp-targets/chatgpt.mjs";
import { installCursor } from "../mcp-targets/cursor.mjs";
import { installVscode } from "../mcp-targets/vscode.mjs";
import { installSoul } from "../mcp-targets/install-soul.mjs";
import { buildServerSpecs } from "../mcp-targets/shared.mjs";

function usage() {
  process.stderr.write(
    "usage: oracle mcp <install|print> [target] [flags]\n" +
      "  targets: claude-code | claude-desktop | codex | copilot | chatgpt | cursor | vscode | generic\n" +
      "  flags:   --with-control --with-soul --project --print --json\n",
  );
}

function emitResult(result, { json = false } = {}) {
  if (result.print && !result.instructions) {
    process.stdout.write(JSON.stringify(result.print, null, 2) + "\n");
  } else if (result.printText) {
    process.stdout.write(result.printText);
  }
  if (result.instructions) {
    process.stdout.write(result.instructions + "\n");
    if (result.print && json) process.stdout.write(JSON.stringify(result.print, null, 2) + "\n");
  }
  if (!result.print && !result.printText && !result.instructions) {
    const line = {
      status: result.status,
      path: result.path || null,
      backup: result.backup || null,
      method: result.method || null,
    };
    process.stdout.write(
      (json ? JSON.stringify(line, null, 2) : `${line.status}${line.path ? " " + line.path : ""}`) + "\n",
    );
  }
}

export default {
  name: "mcp",
  summary: "wire Oracle into AI clients",
  group: "read",
  usage: "oracle mcp install <target> [--with-control] [--with-soul] | oracle mcp print [--target <t>] | oracle mcp watchdog [--once]",
  async run(ctx) {
    const verb = ctx.argv[0];
    if (!verb || verb === "--help" || verb === "-h") {
      usage();
      return verb ? 0 : 1;
    }

    if (verb === "watchdog") {
      const { spawn } = await import("node:child_process");
      const path = await import("node:path");
      const once = ctx.argv.includes("--once");
      const bin = path.join(ctx.root, "bin", "oracle-mcp-watchdog.mjs");
      const child = spawn(process.execPath, [bin, ...(once ? ["--once"] : [])], { stdio: "inherit", detached: true });
      child.unref();
      return 0;
    }

    let values, positionals;
    try {
      ({ values, positionals } = parseArgs({
        args: ctx.argv.slice(1),
        options: {
          "with-control": { type: "boolean", default: false },
          "with-soul": { type: "boolean", default: false },
          project: { type: "boolean", default: false },
          print: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          target: { type: "string" },
        },
        allowPositionals: true,
        strict: false,
      }));
    } catch (err) {
      process.stderr.write(`oracle mcp: ${err.message}\n`);
      usage();
      return 1;
    }

    const withControl = !!values["with-control"];
    const withSoul = !!values["with-soul"];
    const project = !!values.project;
    const json = !!values.json;
    const operator = ctx.resolveOperator ? ctx.resolveOperator() : { ok: false };

    if (withControl && (!operator || !operator.ok)) {
      printOperatorNotInstalled(process.stderr);
      return 3;
    }

    const opts = { oracleRoot: ctx.root, operator, withControl, project, cwd: process.cwd() };

    if (verb === "print") {
      const target = values.target || positionals[0] || "claude-code";
      if (target === "generic" || target === "claude-code") {
        const built = buildServerSpecs(opts);
        if (!built.ok) { printOperatorNotInstalled(process.stderr); return 3; }
        process.stdout.write(JSON.stringify({ mcpServers: built.specs }, null, 2) + "\n");
        return 0;
      }
      if (target === "chatgpt") {
        const r = await installChatgpt({ printOnly: true });
        emitResult(r, { json });
        return 0;
      }
      if (target === "codex" || target === "copilot") {
        emitResult(await installCodex({ ...opts, printOnly: true }), { json });
        return 0;
      }
      if (target === "claude-desktop") {
        emitResult(await installClaudeDesktop({ ...opts, printOnly: true }), { json });
        return 0;
      }
      if (target === "cursor") {
        emitResult(await installCursor({ ...opts, printOnly: true }), { json });
        return 0;
      }
      if (target === "vscode" || target === "vs-code") {
        emitResult(await installVscode({ ...opts, printOnly: true }), { json });
        return 0;
      }
      process.stderr.write(`oracle mcp: unknown target '${target}'\n`);
      return 1;
    }

    if (verb === "install") {
      const target = positionals[0] || values.target;
      if (!target) { usage(); return 1; }
      const printOnly = !!values.print;
      let result;
      if (target === "claude-code") result = await installClaudeCode({ ...opts, printOnly });
      else if (target === "claude-desktop") result = await installClaudeDesktop({ ...opts, printOnly });
      else if (target === "codex" || target === "copilot") result = await installCodex({ ...opts, printOnly });
      else if (target === "chatgpt") result = await installChatgpt({ printOnly });
      else if (target === "cursor") result = await installCursor({ ...opts, printOnly });
      else if (target === "vscode" || target === "vs-code") result = await installVscode({ ...opts, printOnly });
      else if (target === "generic") {
        const built = buildServerSpecs(opts);
        if (!built.ok) { printOperatorNotInstalled(process.stderr); return 3; }
        process.stdout.write(JSON.stringify({ mcpServers: built.specs }, null, 2) + "\n");
        return 0;
      } else {
        process.stderr.write(`oracle mcp: unknown target '${target}'\n`);
        return 1;
      }
      if (!result.ok) {
        if (result.code === 3) printOperatorNotInstalled(process.stderr);
        else process.stderr.write(`oracle mcp: ${result.reason || "failed"}\n`);
        return result.code || 1;
      }
      emitResult(result, { json });

      // Install SOUL if requested (after MCP, independent of MCP outcome)
      if (withSoul) {
        const soulResult = await installSoul(target, { cwd: process.cwd(), printOnly });
        if (soulResult.ok) {
          process.stderr.write(`  soul → ${soulResult.path || "injected"}\n`);
        } else {
          process.stderr.write(`  soul: ${soulResult.reason || "failed"}\n`);
        }
      }
      if (result.status && String(result.status).startsWith("printed") && result.print) {
        process.stdout.write(JSON.stringify(result.print, null, 2) + "\n");
      }
      return 0;
    }

    usage();
    return 1;
  },
};
