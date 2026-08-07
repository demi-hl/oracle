// Oracle BUILD registry — the deploy verb, bounded.
//
// Oracle's scope model was built for TRADING: read, watch, prepare:trade,
// prepare:mint, agent:execute. Every one of those moves value through contracts
// that ALREADY EXIST. "Build on Stable" is a different verb: it brings a new
// contract into existence.
//
// The danger of a deploy verb is that "deploy" normally means "run arbitrary
// bytecode", which no policy can meaningfully allowlist — a compromised agent
// just ships whatever it wants. So this module does NOT implement that.
//
// What it implements: deploy-through-a-pinned-factory. Oracle may call ONE
// allowlisted function on ONE allowlisted factory address per chain. The shape
// of what gets created, and its economics, live in that factory's audited code,
// not in anything the agent chooses. Bounded by construction.
//
// Hard rules enforced here:
//   1. No raw bytecode. A request carrying `bytecode`/`initCode`/`data` is
//      rejected outright — that is the arbitrary-deploy path and it stays shut.
//   2. Factory must be explicitly allowlisted for that exact chainId.
//   3. Unknown chain -> reject. Unknown factory -> reject. Fail closed.
//   4. Building is a PROPOSAL by default. Executing needs a separate scope AND
//      a separate global arm flag, mirroring how execute is gated today.

import { deployGloballyEnabled } from "../flags.mjs";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Fields that would smuggle arbitrary-deploy authority through a build request. */
const FORBIDDEN_FIELDS = ["bytecode", "initCode", "init_code", "data", "creationCode", "salt"];

/**
 * Allowlisted build targets, per chain.
 *
 * `address: null` means "capability known, target not yet pinned" — Oracle
 * understands how to build this thing but physically cannot until an operator
 * supplies a verified factory address. Stable's TokenFactory is deliberately
 * null: the contracts exist and are audited, but nothing is deployed to 988
 * mainnet yet, so there is no address to trust.
 */
export const BUILD_REGISTRY = {
  988: {
    chainName: "Stable Mainnet",
    factories: {
      "stable.tokenFactory": {
        address: envAddress("ORACLE_STABLE_TOKEN_FACTORY"),
        // The ONLY function Oracle may call on it.
        method: "createLaunch",
        creates: ["token", "curve", "feeSplitter"],
        // Economics are fixed in the audited contract, NOT chosen by the agent.
        fixed: {
          creatorFeeBps: 7000,
          protocolFeeBps: 3000,
          curveFeeBps: 100,
          graduationReserveBps: 2000,
          maxReflectionBps: 3000,
        },
        description:
          "Create a bonding-curve token launch. Fee split, curve params, and " +
          "graduation ratio are hardcoded in the audited factory.",
      },
    },
  },
};

function envAddress(name) {
  const v = String(process.env[name] || "").trim();
  return ADDR_RE.test(v) ? v : null;
}

/** Every build target Oracle knows about, including unpinned ones. */
export function listBuildTargets() {
  const out = [];
  for (const [chainId, entry] of Object.entries(BUILD_REGISTRY)) {
    for (const [key, f] of Object.entries(entry.factories)) {
      out.push({
        chainId: Number(chainId),
        chainName: entry.chainName,
        target: key,
        method: f.method,
        creates: f.creates,
        fixed: f.fixed,
        description: f.description,
        address: f.address,
        // A target with no pinned address cannot be built, by design.
        available: Boolean(f.address),
      });
    }
  }
  return out;
}

/**
 * Validate a build request. Returns a normalized plan or throws.
 * Never touches the network. Never signs. Never broadcasts.
 */
export function validateBuildRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("build request must be an object");
  }

  // 1. Arbitrary-deploy attempt -> hard reject before anything else.
  for (const f of FORBIDDEN_FIELDS) {
    if (f in input) {
      throw new Error(
        `arbitrary deploy is not supported: remove "${f}". ` +
          "Oracle builds only through allowlisted factories.",
      );
    }
  }

  const chainId = Number(input.chainId);
  if (!Number.isInteger(chainId)) throw new Error("chainId required");

  const chain = BUILD_REGISTRY[chainId];
  if (!chain) throw new Error(`chain ${chainId} has no build targets (fail closed)`);

  const targetKey = String(input.target || "").trim();
  if (!targetKey) throw new Error("target required");

  const factory = chain.factories[targetKey];
  if (!factory) {
    throw new Error(
      `unknown build target "${targetKey}" on chain ${chainId} (fail closed)`,
    );
  }

  if (!factory.address) {
    throw new Error(
      `build target "${targetKey}" has no pinned factory address on chain ${chainId}. ` +
        "An operator must supply a verified address before Oracle can build here.",
    );
  }

  // 2. Args are validated against the factory's own rules, not free-form.
  const args = validateLaunchArgs(input.args || {}, factory);

  return {
    chainId,
    chainName: chain.chainName,
    target: targetKey,
    factory: factory.address,
    method: factory.method,
    creates: factory.creates,
    fixed: factory.fixed,
    args,
  };
}

/** Argument rules for the stable.tokenFactory createLaunch shape. */
function validateLaunchArgs(args, factory) {
  const name = String(args.name || "").trim();
  const symbol = String(args.symbol || "").trim();
  const creator = String(args.creator || "").trim();
  const imageURI = String(args.imageURI || "").trim();
  const socialsURI = String(args.socialsURI || "").trim();
  const reflectionBps = Number(args.reflectionBps ?? 0);

  if (!name || name.length > 64) throw new Error("args.name required (1-64 chars)");
  if (!symbol || symbol.length > 16) throw new Error("args.symbol required (1-16 chars)");
  if (!ADDR_RE.test(creator)) throw new Error("args.creator must be a valid address");
  if (imageURI.length > 512 || socialsURI.length > 512) throw new Error("args URI too long");

  const maxRefl = factory.fixed?.maxReflectionBps ?? 0;
  if (!Number.isInteger(reflectionBps) || reflectionBps < 0 || reflectionBps > maxRefl) {
    throw new Error(`args.reflectionBps must be an integer 0-${maxRefl}`);
  }

  return { name, symbol, imageURI, socialsURI, creator, reflectionBps };
}

/**
 * Turn a validated request into a PROPOSAL. This is what `prepare:build`
 * produces: a fully-described, human-readable statement of what would be
 * created. It carries no authority and cannot be executed.
 */
export function buildProposal(input) {
  const plan = validateBuildRequest(input);
  return {
    kind: "build.proposal",
    executable: false,
    chainId: plan.chainId,
    chainName: plan.chainName,
    target: plan.target,
    factory: plan.factory,
    method: plan.method,
    creates: plan.creates,
    args: plan.args,
    fixedEconomics: plan.fixed,
    summary: renderBuildProposal(plan),
  };
}

/** Plain-English render so a user sees exactly what they authorize. */
export function renderBuildProposal(plan) {
  const f = plan.fixed || {};
  const lines = [
    `Create "${plan.args.name}" ($${plan.args.symbol}) on ${plan.chainName}.`,
    `Factory: ${plan.factory} (${plan.method})`,
    `Creates: ${plan.creates.join(", ")}`,
    `Creator: ${plan.args.creator}`,
  ];
  if (plan.args.reflectionBps > 0) {
    lines.push(`Reflections: ${(plan.args.reflectionBps / 100).toFixed(2)}% of trade fees to holders`);
  }
  lines.push(
    `Fixed by the audited factory (agent cannot change): ` +
      `creator ${(f.creatorFeeBps || 0) / 100}% / protocol ${(f.protocolFeeBps || 0) / 100}% of fees, ` +
      `${(f.curveFeeBps || 0) / 100}% trade fee, ` +
      `${(f.graduationReserveBps || 0) / 100}% of supply to LP at graduation.`,
  );
  lines.push("No arbitrary code is deployed. Only this factory call.");
  return lines.join("\n");
}

/**
 * Whether an actual build broadcast is permitted right now.
 * Requires BOTH the explicit scope AND the global arm flag — same
 * belt-and-braces posture as execute.
 */
export function buildExecutionAllowed(scopes = []) {
  const hasScope = Array.isArray(scopes) && scopes.includes(BUILD_EXECUTE_SCOPE);
  return { allowed: hasScope && deployGloballyEnabled(), hasScope, armed: deployGloballyEnabled() };
}

export const BUILD_PREPARE_SCOPE = "prepare:build";
export const BUILD_EXECUTE_SCOPE = "build:factory";
