import {
  HERMES_PYPI,
  installManagedHermes,
  runtimeStatus,
  runtimeVenvDir,
} from "../runtime.mjs";

function usage() {
  return [
    "oracle bootstrap - optionally install an isolated Hermes compatibility runtime",
    "",
    "  oracle bootstrap            install into ~/.config/oracle/runtime/venv",
    "  oracle bootstrap --upgrade  upgrade the managed runtime",
    "  oracle bootstrap --status   show what runtime oracle would use",
    "  oracle bootstrap --json     machine-readable status",
    "",
    "notes:",
    "  a hermes on PATH always wins; bootstrap never touches system python",
    "  read/prepare commands (chain, scan, route, data) never need this",
  ].join("\n");
}

export default {
  name: "bootstrap",
  summary: "optionally install a Hermes compatibility runtime",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = ctx.argv;
    if (args.includes("-h") || args.includes("--help")) {
      process.stdout.write(usage() + "\n");
      return 0;
    }

    const json = args.includes("--json");
    const status = runtimeStatus();

    if (args.includes("--status") || json) {
      if (json) {
        process.stdout.write(JSON.stringify(status, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(
        [
          `hermes:        ${status.hermes.ok ? `${status.hermes.bin} (${status.hermes.source})` : "not installed"}`,
          `managed venv:  ${status.managedVenv}`,
          `managed built: ${status.managedInstalled ? "yes" : "no"}`,
          `host python:   ${status.hostPython ? `${status.hostPython.bin} (${status.hostPython.version})` : "none supported (need 3.11-3.13)"}`,
          `uv:            ${status.uv || "not installed (oracle will install it locally)"}`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    const upgrade = args.includes("--upgrade");

    if (status.hermes.ok && status.hermes.source === "path" && !upgrade) {
      process.stdout.write(
        `hermes already on PATH: ${status.hermes.bin}\nnothing to do. run: oracle\n`,
      );
      return 0;
    }

    process.stdout.write(
      `installing ${HERMES_PYPI} into ${runtimeVenvDir()}\n` +
        (status.hostPython
          ? `using python ${status.hostPython.version} (${status.hostPython.bin})\n`
          : "provisioning an isolated python 3.13 with uv\n") +
        "this takes a few minutes on first run\n\n",
    );

    const r = installManagedHermes({ upgrade });
    if (!r.ok) {
      process.stderr.write(`oracle bootstrap failed: ${r.reason}\n`);
      if (r.stderr) process.stderr.write(`${r.stderr}\n`);
      return 1;
    }

    process.stdout.write(
      r.reused
        ? `runtime already present: ${r.bin}\n`
        : `\nruntime ready: ${r.bin}\nrun: oracle\n`,
    );
    return 0;
  },
};
