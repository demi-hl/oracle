import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  verifyCapability,
  requireCapability,
  mintCapability,
  authPreimage,
  AUTH_DOMAIN,
} from "../src/agent-auth.mjs";

// Deterministic keys (test-only).
const owner = new Wallet("0x" + "1".repeat(64));
const agent = new Wallet("0x" + "2".repeat(64));
const stranger = new Wallet("0x" + "3".repeat(64));

test("preimage has the fixed domain + lowercased agent + conditions", () => {
  const pre = authPreimage(agent.address, "chain=1&action=exec.broadcast");
  assert.equal(pre, AUTH_DOMAIN + agent.address.toLowerCase() + ":chain=1&action=exec.broadcast");
});

test("valid unconstrained capability verifies", async () => {
  const tag = await mintCapability(owner, agent.address, "");
  const r = verifyCapability(tag, { agentAddress: agent.address });
  assert.equal(r.ok, true);
  assert.equal(r.owner.toLowerCase(), owner.address.toLowerCase());
});

test("chain clause gates chainId", async () => {
  const tag = await mintCapability(owner, agent.address, "chain=8453");
  assert.equal(verifyCapability(tag, { agentAddress: agent.address, chainId: 8453 }).ok, true);
  const bad = verifyCapability(tag, { agentAddress: agent.address, chainId: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "chain-not-authorized");
});

test("action clause gates the scope", async () => {
  const tag = await mintCapability(owner, agent.address, "action=exec.broadcast");
  assert.equal(verifyCapability(tag, { agentAddress: agent.address, action: "exec.broadcast" }).ok, true);
  const bad = verifyCapability(tag, { agentAddress: agent.address, action: "exec.sign" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "action-not-authorized");
});

test("expires< enforces wall-clock expiry against verifier time", async () => {
  const tag = await mintCapability(owner, agent.address, "expires<1000");
  assert.equal(verifyCapability(tag, { agentAddress: agent.address, now: 999 }).ok, true);
  const expired = verifyCapability(tag, { agentAddress: agent.address, now: 1000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});

test("notbefore> enforces a start time", async () => {
  const tag = await mintCapability(owner, agent.address, "notbefore>1000");
  assert.equal(verifyCapability(tag, { agentAddress: agent.address, now: 999 }).ok, false);
  assert.equal(verifyCapability(tag, { agentAddress: agent.address, now: 1001 }).ok, true);
});

test("multiple clauses all enforced (order preserved in preimage)", async () => {
  const cond = "chain=8453&action=exec.broadcast&expires<2000";
  const tag = await mintCapability(owner, agent.address, cond);
  assert.equal(tag[2], cond, "conditions string stored verbatim");
  const ok = verifyCapability(tag, { agentAddress: agent.address, chainId: 8453, action: "exec.broadcast", now: 1500 });
  assert.equal(ok.ok, true);
});

test("tampered conditions break the signature", async () => {
  const tag = await mintCapability(owner, agent.address, "chain=1");
  tag[2] = "chain=8453"; // widen the grant after signing
  const r = verifyCapability(tag, { agentAddress: agent.address, chainId: 8453 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-owner-mismatch");
});

test("capability bound to one agent does not verify for another", async () => {
  const tag = await mintCapability(owner, agent.address, "");
  const r = verifyCapability(tag, { agentAddress: stranger.address });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-owner-mismatch");
});

test("stranger signature is not the claimed owner", async () => {
  // Owner field claims `owner` but signature is from `stranger`.
  const cond = "chain=1";
  const sig = await stranger.signMessage(authPreimage(agent.address, cond));
  const tag = ["auth", owner.address, cond, sig];
  const r = verifyCapability(tag, { agentAddress: agent.address, chainId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-owner-mismatch");
});

test("self-attestation rejected", async () => {
  const tag = await mintCapability(owner, agent.address, "");
  tag[1] = agent.address; // claim agent authorized itself
  const r = verifyCapability(tag, { agentAddress: agent.address });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "self-attestation");
});

test("malformed tag shapes rejected", () => {
  assert.equal(verifyCapability(["auth", owner.address, ""], { agentAddress: agent.address }).reason, "malformed-tag");
  assert.equal(verifyCapability(["nope", owner.address, "", "0x"], { agentAddress: agent.address }).reason, "malformed-tag");
  assert.equal(verifyCapability("notarray", { agentAddress: agent.address }).reason, "malformed-tag");
});

test("malformed conditions rejected before signature check", async () => {
  for (const bad of ["chain=1&", "&chain=1", "chain=1&&action=x", "chain=01", "chain= 1", "bogus=1"]) {
    await assert.rejects(() => mintCapability(owner, agent.address, bad), /conditions/);
  }
});

test("non-canonical decimal in a presented tag is rejected on verify", async () => {
  // Hand-build a tag with a leading-zero chain that the owner 'signed' anyway.
  const cond = "chain=01";
  const sig = await owner.signMessage(AUTH_DOMAIN + agent.address.toLowerCase() + ":" + cond);
  const tag = ["auth", owner.address, cond, sig];
  const r = verifyCapability(tag, { agentAddress: agent.address, chainId: 1 });
  assert.equal(r.ok, false);
});

// ---- requireCapability: the actual gate decision (verify + owner trust) ----

test("requireCapability accepts a valid cap from a trusted owner", async () => {
  const tag = await mintCapability(owner, agent.address, "chain=8453&action=exec.broadcast");
  const r = requireCapability(tag, {
    agentAddress: agent.address,
    chainId: 8453,
    action: "exec.broadcast",
    owners: [owner.address],
  });
  assert.equal(r.ok, true);
  assert.equal(r.owner.toLowerCase(), owner.address.toLowerCase());
});

test("requireCapability FAILS CLOSED with an empty trusted-owner set", async () => {
  const tag = await mintCapability(owner, agent.address, "");
  const r = requireCapability(tag, { agentAddress: agent.address, owners: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-trusted-owners");
});

test("requireCapability rejects a valid cap from an untrusted owner", async () => {
  // stranger legitimately signs a cap for the agent, but is not trusted.
  const tag = await mintCapability(stranger, agent.address, "");
  const r = requireCapability(tag, {
    agentAddress: agent.address,
    owners: [owner.address], // only owner is trusted
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "owner-not-trusted");
  assert.equal(r.owner.toLowerCase(), stranger.address.toLowerCase());
});

test("requireCapability rejects an expired cap even from a trusted owner", async () => {
  const tag = await mintCapability(owner, agent.address, "expires<1000");
  const r = requireCapability(tag, {
    agentAddress: agent.address,
    owners: [owner.address],
    now: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("requireCapability enforces chain + action gating under trust", async () => {
  const tag = await mintCapability(owner, agent.address, "chain=1&action=exec.broadcast");
  const wrongChain = requireCapability(tag, {
    agentAddress: agent.address, chainId: 8453, action: "exec.broadcast", owners: [owner.address],
  });
  assert.equal(wrongChain.ok, false);
  assert.equal(wrongChain.reason, "chain-not-authorized");
  const wrongAction = requireCapability(tag, {
    agentAddress: agent.address, chainId: 1, action: "exec.sign", owners: [owner.address],
  });
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongAction.reason, "action-not-authorized");
});

test("requireCapability owner trust is case-insensitive", async () => {
  const tag = await mintCapability(owner, agent.address, "");
  const r = requireCapability(tag, {
    agentAddress: agent.address,
    owners: [owner.address.toUpperCase()],
  });
  assert.equal(r.ok, true);
});

test("requireCapability rejects a malformed/missing capability", () => {
  const r = requireCapability(undefined, { agentAddress: agent.address, owners: [owner.address] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed-tag");
});
