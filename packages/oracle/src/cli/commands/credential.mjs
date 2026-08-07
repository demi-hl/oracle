export default {
  name: "credential",
  summary: "OS credential store glue",
  group: "sign",
  usage: "oracle credential <get|set|delete> ...",
  async run(ctx) {
    return ctx.dispatchOperator("oracle-credential", ctx.argv, { appendHintOnError: true });
  },
};
