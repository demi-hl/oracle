import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signOrderV2_1271,
  buildSignedOrderV2,
  postClobOrder,
  polyPrepareOrder,
} from "../src/data/providers/poly-clob.mjs";

test("poly-clob deep-import sign/post refuse", async () => {
  await assert.rejects(() => signOrderV2_1271(), /prepare-only/);
  await assert.rejects(() => buildSignedOrderV2(), /prepare-only/);
  await assert.rejects(() => postClobOrder(), /prepare-only/);
});

test("polyPrepareOrder stamps unsigned envelope", () => {
  const p = polyPrepareOrder({
    tokenId: "123",
    side: "BUY",
    price: "0.5",
    size: "1",
    maker: "0x0000000000000000000000000000000000000001",
    signer: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(p.kind, "poly-order");
  assert.ok(p.oraclePrepared);
  assert.ok(p.domain && p.types && p.value);
  assert.equal(p.value?.signature, undefined);
});
