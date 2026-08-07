export default {
  name: "signer",
  summary: "loopback signer daemon",
  group: "sign",
  usage: "oracle signer [--port N ...]",
  async run(ctx) {
    return ctx.dispatchOperator("oracle-signer", ctx.argv, { appendHintOnError: true });
  },
};
