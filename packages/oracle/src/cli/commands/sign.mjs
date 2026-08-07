export default {
  name: "sign",
  summary: "provision / check the local signer (opt-in)",
  group: "sign",
  usage: "oracle sign <init|doctor> ...",
  async run(ctx) {
    const verb = ctx.argv[0];
    if (verb === "init") {
      return ctx.dispatchOperator("oracle-agentic-init", ctx.argv.slice(1), { appendHintOnError: true });
    }
    if (verb === "doctor") {
      return ctx.dispatchOperator("oracle-agentic-doctor", ctx.argv.slice(1), { appendHintOnError: true });
    }
    process.stderr.write(
      "usage: oracle sign <init|doctor> ...\n" +
        "  oracle sign init      provision keys + policy (interactive)\n" +
        "  oracle sign doctor    check local signer readiness\n",
    );
    return 1;
  },
};
