export default {
  name: "runner",
  summary: "action runner daemon",
  group: "sign",
  usage: "oracle runner [--interval-ms N ...]",
  async run(ctx) {
    return ctx.dispatchOperator("oracle-runner", ctx.argv, { appendHintOnError: true });
  },
};
