import { test } from "node:test";
import assert from "node:assert/strict";
import { solanaRpc } from "../src/data/providers/solana-rpc.mjs";

test("requestAirdrop refused prepare-only", async () => {
  await assert.rejects(() => solanaRpc("requestAirdrop", ["11111111111111111111111111111111", 1]), /prepare-only|airdrop/);
});
