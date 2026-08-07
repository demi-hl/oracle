import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCALS_ONLY_CHAIN_ID,
  LOCALS_ONLY_CONTRACT,
  LOCALS_ONLY_RPC,
  holderBalance,
  isAddress,
} from "../src/licensing/locals-only.mjs";
import { run as runFees } from "../src/cli/commands/fees.mjs";

const HOLDER = "0x1c0ec596303ce6666f5a4d24c29e78cf881cb5d3";

function sink() {
  let value = "";
  return { write(chunk) { value += chunk; }, value: () => value };
}

test("Locals Only identity is pinned to the verified HyperEVM collection", () => {
  assert.equal(LOCALS_ONLY_CONTRACT, "0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75");
  assert.equal(LOCALS_ONLY_CHAIN_ID, 999);
  assert.match(LOCALS_ONLY_RPC, /^https:\/\//);
});

test("holderBalance is a read-only balance lookup with an injectable transport", async () => {
  let checked;
  const balance = await holderBalance(HOLDER, {
    balanceOf: async (address) => {
      checked = address;
      return 2n;
    },
  });
  assert.equal(checked, HOLDER);
  assert.equal(balance, 2n);
});

test("holderBalance rejects malformed addresses before transport", async () => {
  await assert.rejects(() => holderBalance("not-an-address", { balanceOf: async () => 1n }), /invalid-address/);
  assert.equal(isAddress(HOLDER), true);
  assert.equal(isAddress("0x1"), false);
});

test("fees check reports a holder's zero-fee eligibility", async () => {
  const out = sink();
  const code = await runFees(["check", HOLDER], { out, err: sink(), balanceOf: async () => 1n });
  assert.equal(code, 0);
  assert.match(out.value(), /Oracle integrator fee: 0%/);
  assert.match(out.value(), /access remains public/i);
});

test("fees check never denies a non-holder product access", async () => {
  const out = sink();
  const code = await runFees(["check", HOLDER], { out, err: sink(), balanceOf: async () => 0n });
  assert.equal(code, 0);
  assert.match(out.value(), /standard Oracle fee applies/i);
  assert.doesNotMatch(out.value(), /denied|requires|locked/i);
});

test("fees status without a configured wallet reports public access and standard fees", async () => {
  const out = sink();
  let checked = false;
  const code = await runFees(["status"], {
    out,
    err: sink(),
    agentAddress: () => null,
    balanceOf: async () => { checked = true; return 1n; },
  });
  assert.equal(code, 0);
  assert.equal(checked, false);
  assert.match(out.value(), /wallet: not configured/i);
  assert.match(out.value(), /standard Oracle fee applies/i);
  assert.match(out.value(), /access remains public/i);
});

test("ownership lookup failure falls back to standard fees without denying access", async () => {
  const out = sink();
  const code = await runFees(["check", HOLDER], {
    out,
    err: sink(),
    balanceOf: async () => { throw new Error("rpc down"); },
  });
  assert.equal(code, 0);
  assert.match(out.value(), /fee-waiver status: unavailable/i);
  assert.match(out.value(), /standard Oracle fee applies/i);
  assert.match(out.value(), /access remains public/i);
});
