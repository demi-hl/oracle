export default {
  name: "sign",
  summary: "provision / check / import local signer keys",
  group: "sign",
  usage: "oracle sign <init|doctor|import> ...",
  async run(ctx) {
    const verb = ctx.argv[0];
    if (verb === "init") {
      return ctx.dispatchOperator("oracle-agentic-init", ctx.argv.slice(1), { appendHintOnError: true });
    }
    if (verb === "doctor") {
      return ctx.dispatchOperator("oracle-agentic-doctor", ctx.argv.slice(1), { appendHintOnError: true });
    }
    if (verb === "import") {
      const { createInterface } = await import("node:readline");
      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const dir = process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");
      const keyDir = join(dir, "keys");
      const keyFile = join(keyDir, "evm.json");

      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

      process.stderr.write("\nPaste your EVM private key (0x...):\n> ");
      const key = await ask("");

      rl.close();

      const clean = key.trim();
      if (!clean.startsWith("0x") || clean.length < 64) {
        process.stderr.write("oracle sign: invalid private key — must be 0x-prefixed hex\n");
        return 1;
      }

      if (existsSync(keyFile)) {
        process.stderr.write(`oracle sign: ${keyFile} already exists — remove it first or use 'oracle sign doctor'\n`);
        return 1;
      }

      mkdirSync(keyDir, { recursive: true, mode: 0o700 });
      writeFileSync(keyFile, JSON.stringify({ key: clean }, null, 2) + "\n", { mode: 0o600 });
      process.stderr.write(`Saved to ${keyFile} (0600)\n`);
      return 0;
    }
    process.stderr.write(
      "usage: oracle sign <init|doctor|import> ...\n" +
        "  oracle sign init      provision keys + policy (interactive)\n" +
        "  oracle sign import    import an existing EVM private key\n" +
        "  oracle sign doctor    check local signer readiness\n",
    );
    return 1;
  },
};