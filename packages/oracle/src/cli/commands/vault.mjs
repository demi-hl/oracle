export default {
  name: "vault",
  summary: "encrypt local key files at rest",
  group: "sign",
  usage: "oracle vault <encrypt|rekey|inspect|decrypt> ...",
  async run(ctx) {
    return ctx.dispatchOperator("oracle-vault", ctx.argv, { appendHintOnError: true });
  },
};
