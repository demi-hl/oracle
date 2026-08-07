// Chain scanner contract.
//
// The problem this solves: Oracle knows 11 chains today, and every one of them was
// wired by hand. Adding the 12th shouldn't mean writing another bespoke integration
// -- it should mean filling in a config and, at most, one adapter function.
//
// So a scanner is defined by DATA (what the chain is) plus a small set of CAPABILITY
// functions (what we can actually do on it). Anything unimplemented is absent, not
// faked, and `capabilities()` reports the truth. This mirrors the data catalog's
// honesty rule: coverage is not capability.
//
// Nothing here signs. A scanner's terminal output is an UNSIGNED transaction.

/**
 * The capability surface a scanner may implement. Every one is optional; a chain
 * with only `blockNumber` and `resolveToken` is a legitimate, useful scanner.
 *
 * Ordered roughly by how much you need to know about the chain to provide it.
 */
export const SCANNER_CAPABILITIES = Object.freeze([
  "blockNumber",       // current head
  "nativeBalance",     // native token balance for an address
  "tokenBalance",      // ERC-20 balance
  "resolveToken",      // address or symbol -> { address, symbol, decimals, name }
  "resolvePools",      // token -> tradeable pools, with liquidity
  "scanBlocks",        // range scan for events (launches, transfers)
  "scoreRisk",         // structured risk assessment, honestly labelled
  "quote",             // price a route
  "sellSimulation",    // can it be sold? round-trip check
  "prepareUnsignedTx", // build a transaction for the USER to sign
]);

/**
 * Evidence freshness labels. A scanner must say which one applies to each finding,
 * because "no data" and "data from 40 minutes ago" lead to different decisions and
 * conflating them is how people size against stale reserves.
 */
export const EVIDENCE = Object.freeze({
  LIVE: "LIVE",               // read this call, from the chain
  CACHED: "CACHED",           // read recently, within the stated ttl
  STALE: "STALE",             // older than ttl; usable only with the caveat stated
  UNKNOWN: "UNKNOWN",         // we tried and could not determine it
  UNAVAILABLE: "UNAVAILABLE", // this chain/provider cannot answer at all
});

/**
 * Risk verdicts. Deliberately coarse: a false sense of precision ("risk 62/100")
 * invites people to trade a number they don't understand.
 */
export const RISK = Object.freeze({
  PASS: "PASS",       // checks ran and found nothing disqualifying
  CAUTION: "CAUTION", // something real to know before sizing
  FAIL: "FAIL",       // disqualifying: do not trade
  UNKNOWN: "UNKNOWN", // could not assess -- NOT the same as PASS
});

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a chain scanner definition.
 *
 * Fails closed on the things that cause real losses: an unverified venue, a
 * placeholder address, a chain id that doesn't match the RPC, a scanner that claims
 * a capability it didn't implement.
 *
 * @param {object} def
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateScanner(def = {}) {
  const errors = [];
  const warnings = [];

  if (!def || typeof def !== "object") {
    return { ok: false, errors: ["definition must be an object"], warnings };
  }

  if (!Number.isInteger(def.chainId) || def.chainId <= 0) {
    errors.push("chainId must be a positive integer");
  }
  if (typeof def.key !== "string" || !/^[a-z][a-z0-9-]*$/.test(def.key || "")) {
    errors.push('key must be a lowercase slug (e.g. "base")');
  }
  if (typeof def.name !== "string" || !def.name.trim()) {
    errors.push("name is required");
  }

  // RPC discovery is env-var driven so a public repo never carries endpoints.
  if (!Array.isArray(def.rpcEnv) || def.rpcEnv.length === 0) {
    errors.push("rpcEnv must list at least one environment variable name");
  } else {
    for (const v of def.rpcEnv) {
      if (typeof v !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(v)) {
        errors.push(`rpcEnv entry "${v}" should be an UPPER_SNAKE env var name`);
      }
    }
  }

  if (def.nativeCurrency) {
    const nc = def.nativeCurrency;
    if (typeof nc.symbol !== "string" || !nc.symbol) {
      errors.push("nativeCurrency.symbol is required when nativeCurrency is set");
    }
    if (!Number.isInteger(nc.decimals)) {
      errors.push("nativeCurrency.decimals must be an integer");
    }
  }

  // Venue addresses: every one must be well-formed AND carry provenance. An
  // allowlisted spoofed router defeats every other control in the system, so
  // "where did this address come from" is required, not documentation.
  for (const [i, v] of (def.venues || []).entries()) {
    const at = `venues[${i}]`;
    if (!v || typeof v !== "object") {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (!ADDRESS_RE.test(v.address || "")) {
      errors.push(`${at}.address is not a valid 20-byte address`);
    }
    if (/^0x0{40}$/.test(v.address || "")) {
      errors.push(`${at}.address is the zero address -- placeholder left in place?`);
    }
    if (!v.kind) errors.push(`${at}.kind is required (router|quoter|factory|...)`);
    if (!v.verified) {
      errors.push(
        `${at} must record verification: { verified: { method, source, date } }. ` +
          "An unverified venue stays blocked.",
      );
    } else {
      if (!v.verified.method) errors.push(`${at}.verified.method is required`);
      if (!v.verified.source) errors.push(`${at}.verified.source is required`);
      if (!v.verified.date) warnings.push(`${at}.verified.date missing -- add one so staleness is visible`);
    }
  }

  // Capability honesty: declaring a capability you didn't implement is the exact
  // failure mode the data catalog's tier labels exist to prevent.
  const impl = def.capabilities || {};
  for (const name of Object.keys(impl)) {
    if (!SCANNER_CAPABILITIES.includes(name)) {
      errors.push(`unknown capability "${name}"`);
    } else if (typeof impl[name] !== "function") {
      errors.push(`capability "${name}" must be a function`);
    }
  }
  if (Object.keys(impl).length === 0) {
    warnings.push("scanner implements no capabilities -- it can only be registered, not used");
  }

  // prepareUnsignedTx without a quote is a footgun: you would be building a
  // transaction with no priced expectation to check the result against.
  if (impl.prepareUnsignedTx && !impl.quote) {
    warnings.push(
      "prepareUnsignedTx without quote: no priced expectation to validate the built tx against",
    );
  }
  // A chain where you can buy but cannot verify you can sell.
  if (impl.prepareUnsignedTx && !impl.sellSimulation) {
    warnings.push(
      "prepareUnsignedTx without sellSimulation: cannot prove an asset is exitable before buying",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Wrap a validated definition into a usable scanner.
 *
 * The wrapper's job is to make unimplemented capabilities fail LOUDLY and
 * consistently, rather than each call site inventing its own undefined-check.
 */
export function createScanner(def) {
  const { ok, errors, warnings } = validateScanner(def);
  if (!ok) {
    throw new Error(`invalid scanner for ${def?.key ?? "<unknown>"}:\n  - ${errors.join("\n  - ")}`);
  }

  const impl = def.capabilities || {};
  const supported = SCANNER_CAPABILITIES.filter((c) => typeof impl[c] === "function");

  const scanner = {
    key: def.key,
    chainId: def.chainId,
    name: def.name,
    rpcEnv: [...def.rpcEnv],
    nativeCurrency: def.nativeCurrency ? { ...def.nativeCurrency } : null,
    explorer: def.explorer || null,
    venues: (def.venues || []).map((v) => ({ ...v })),
    warnings,

    /** Honest capability report: what this chain can actually do. */
    capabilities() {
      return {
        chainId: def.chainId,
        key: def.key,
        supported: [...supported],
        unsupported: SCANNER_CAPABILITIES.filter((c) => !supported.includes(c)),
      };
    },

    supports(cap) {
      return supported.includes(cap);
    },
  };

  // Bind each capability; refuse the rest with an actionable message.
  for (const cap of SCANNER_CAPABILITIES) {
    if (supported.includes(cap)) {
      scanner[cap] = async (...args) => impl[cap](...args, { scanner });
    } else {
      scanner[cap] = async () => {
        throw new Error(
          `${def.key} (chain ${def.chainId}) does not implement "${cap}". ` +
            `Supported: ${supported.join(", ") || "none"}. ` +
            "An unimplemented capability is absent, not assumed -- implement it or " +
            "treat this chain as fail-closed for that operation.",
        );
      };
    }
  }

  return Object.freeze(scanner);
}

/** In-memory scanner registry. */
const REGISTRY = new Map();

export function registerScanner(def) {
  const scanner = createScanner(def);
  REGISTRY.set(scanner.chainId, scanner);
  return scanner;
}

export function getScanner(chainId) {
  return REGISTRY.get(Number(chainId)) || null;
}

export function listScanners() {
  return [...REGISTRY.values()];
}

export function __clearScanners() {
  REGISTRY.clear();
}

/**
 * Coverage matrix across registered scanners: which chains can do what.
 *
 * This is what answers "can we trade on X" with a tier instead of a yes/no.
 */
export function scannerCoverage() {
  const chains = {};
  for (const s of REGISTRY.values()) {
    chains[s.chainId] = {
      key: s.key,
      name: s.name,
      ...s.capabilities(),
      venueCount: s.venues.length,
      // A chain with no verified venue cannot route value, by design.
      failClosed: s.venues.length === 0,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    chainCount: REGISTRY.size,
    capabilities: [...SCANNER_CAPABILITIES],
    chains,
  };
}
