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
      const { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync, statSync } = await import("node:fs");
      const { join, parse } = await import("node:path");
      const { homedir, platform } = await import("node:os");

      const dir = process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");
      const keyDir = join(dir, "keys");
      const keyFile = join(keyDir, "evm.json");
      const keyfilePath = ctx.argv.includes("--keyfile") ? ctx.argv[ctx.argv.indexOf("--keyfile") + 1] : null;

      if (keyfilePath) {
        // Import from file, auto-delete after
        if (!existsSync(keyfilePath)) {
          process.stderr.write(`oracle sign: ${keyfilePath} not found\n`);
          return 1;
        }
        const content = readFileSync(keyfilePath, "utf8").trim();
        const clean = content.startsWith("{") ? JSON.parse(content).key || content : content;
        if (!clean.startsWith("0x") || clean.length < 64) {
          process.stderr.write("oracle sign: invalid private key in file\n");
          return 1;
        }
        if (existsSync(keyFile)) {
          process.stderr.write(`oracle sign: ${keyFile} already exists\n`);
          return 1;
        }
        mkdirSync(keyDir, { recursive: true, mode: 0o700 });
        writeFileSync(keyFile, JSON.stringify({ key: clean }, null, 2) + "\n", { mode: 0o600 });
        process.stderr.write(`Saved to ${keyFile} (0600)\n`);

        // Overwrite with zeros, then delete
        try {
          try { writeFileSync(keyfilePath, Buffer.alloc(statSync(keyfilePath).size, 0x00)); } catch {}
          unlinkSync(keyfilePath);
        } catch {}
        process.stderr.write(`Cleaned up ${keyfilePath}\n`);
        return 0;
      }

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