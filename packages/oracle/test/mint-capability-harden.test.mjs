import test from "node:test";
import assert from "node:assert/strict";
import { mintCapability } from "../src/agent-auth.mjs";

test("mintCapability refuses raw private key string", async () => {
  await assert.rejects(
    () => mintCapability("0x" + "11".repeat(32), "0x" + "22".repeat(20)),
    /raw key material/,
  );
});

test("mintCapability refuses object exposing privateKey", async () => {
  await assert.rejects(
    () =>
      mintCapability(
        {
          privateKey: "0x" + "11".repeat(32),
          getAddress: async () => "0x" + "33".repeat(20),
          signMessage: async () => "0xsig",
        },
        "0x" + "22".repeat(20),
      ),
    /privateKey\/mnemonic|plain objects/,
  );
});
