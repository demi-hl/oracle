// Bridge and reachability.
//
// The best price on a venue you cannot reach is not the best execution. This module annotates
// a route with what it costs and how long it takes to move funds to the chain the venue lives on.
//
// Three rules hold everywhere in this file:
//   1. Nothing here is live. Every emission is an ESTIMATE, never a quote.
//   2. Unknown is not zero. An unlisted chain pair returns costAccounted false with a machine
//      readable reason. An invented bridge cost would silently change which venue wins.
//   3. A bridged leg is never atomic. Origin confirmation is not destination arrival, and that
//      gap is where users double send. The nonAtomic flag cannot be dropped or set false.
//
// All bps values are fixed point from src/num.mjs. estMinutes is a plain nonnegative integer
// count of wall clock minutes, which is a duration and not a monetary field.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseDecimal } from './num.mjs';

const ROUTES_PATH = fileURLToPath(new URL('../fixtures/bridge_routes.json', import.meta.url));

export const BRIDGE_ESTIMATE_KIND = 'bridge-estimate';
const ESTIMATE_LABEL = 'ESTIMATE';
const MACHINE_REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ROUTE_KINDS = new Set(['identity', 'table', 'unknown', 'unevaluated']);
const CONFIDENCES = new Set(['exact', 'estimate']);

// Structural zero. The identity answer is derived from this constant, never from a table row,
// so no fixture edit can turn "funds are already there" into a nonzero cost.
const ZERO_BPS = Object.freeze(parseDecimal('0'));

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFixed(value) {
  return (
    isRecord(value) &&
    typeof value.mantissa === 'bigint' &&
    Number.isSafeInteger(value.scale) &&
    value.scale >= 0
  );
}

function requireChain(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`bridge.${name}`, 'must be a nonempty chain name');
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function routeError(message) {
  throw new TypeError(`Fixture fixtures/bridge_routes.json: ${message}`);
}

function validateRouteTable(table, origin) {
  if (!isRecord(table)) routeError(`${origin} root must be an object`);
  if (!Array.isArray(table.routes) || table.routes.length === 0) {
    routeError(`${origin} routes must be a nonempty array`);
  }

  const seen = new Set();
  table.routes.forEach((route, index) => {
    const at = `${origin} routes[${index}]`;
    if (!isRecord(route)) routeError(`${at} must be an object`);
    for (const key of ['from', 'to']) {
      if (typeof route[key] !== 'string' || route[key].length === 0) {
        routeError(`${at}.${key} must be a nonempty string`);
      }
    }
    // Authored as a decimal string so it enters fixed point without ever being a float.
    if (typeof route.estBps !== 'string' || !/^\d+(?:\.\d+)?$/.test(route.estBps)) {
      routeError(`${at}.estBps must be a nonnegative decimal string`);
    }
    if (!Number.isSafeInteger(route.estMinutes) || route.estMinutes < 0) {
      routeError(`${at}.estMinutes must be a nonnegative safe integer`);
    }
    if (typeof route.atomic !== 'boolean') {
      routeError(`${at}.atomic must be a boolean`);
    }
    if (route.from !== route.to && route.atomic !== false) {
      routeError(`${at}.atomic must be false because a bridged leg is not atomic`);
    }
    if (
      Object.hasOwn(route, 'exercisedByLiveVenue') &&
      typeof route.exercisedByLiveVenue !== 'boolean'
    ) {
      routeError(`${at}.exercisedByLiveVenue must be a boolean when present`);
    }

    const key = `${route.from}\u0000${route.to}`;
    if (seen.has(key)) routeError(`${at} duplicates directed pair ${route.from} to ${route.to}`);
    seen.add(key);
  });

  return table;
}

let cachedTable;

export function loadBridgeRoutes({ path = ROUTES_PATH } = {}) {
  if (path === ROUTES_PATH && cachedTable) return cachedTable;

  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Fixture fixtures/bridge_routes.json is missing at ${path}`);
    }
    throw new Error(`Fixture fixtures/bridge_routes.json could not be read: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(
      `Fixture fixtures/bridge_routes.json contains invalid JSON: ${error.message}`,
    );
  }

  const table = deepFreeze(validateRouteTable(data, 'root'));
  if (path === ROUTES_PATH) cachedTable = table;
  return table;
}

function resolveTable(table) {
  if (table === undefined) return loadBridgeRoutes();
  return deepFreeze(validateRouteTable(table, 'supplied'));
}

function chainsOf(table) {
  const chains = new Set();
  for (const route of table.routes) {
    chains.add(route.from);
    chains.add(route.to);
  }
  return chains;
}

/** Every chain the estimate table knows about, live or forward looking. */
export function listBridgeChains({ table } = {}) {
  return [...chainsOf(resolveTable(table))].sort();
}

function findRoute(table, from, to) {
  // Directed lookup only. A table that authored one direction says nothing about the other,
  // and withdrawal cost is genuinely not symmetric in the real world.
  return table.routes.find((route) => route.from === from && route.to === to) ?? null;
}

function emit(estimate) {
  return Object.freeze({
    kind: BRIDGE_ESTIMATE_KIND,
    label: ESTIMATE_LABEL,
    isQuote: false,
    live: false,
    ...estimate,
  });
}

/**
 * Estimate the cost and time of getting funds from one chain to another.
 * Returns a frozen estimate. It is never a quote and never a promise.
 */
export function estimateBridge({ from, to, table } = {}) {
  requireChain(from, 'from');
  requireChain(to, 'to');

  const routes = resolveTable(table);

  if (from === to) {
    // Funds are already there. This is the common case and it is exactly zero, not a small
    // fudge factor. Read only for metadata, never for the cost itself.
    const row = findRoute(routes, from, to);
    const exercised = row?.exercisedByLiveVenue === true;
    return emit({
      from,
      to,
      route: 'identity',
      bridged: false,
      nonAtomic: false,
      estBps: ZERO_BPS,
      estMinutes: 0,
      costAccounted: true,
      confidence: 'exact',
      exercisedByLiveVenue: exercised,
      forwardLooking: !exercised,
      reason: null,
      evidence: { knownFrom: true, knownTo: true },
      source: 'identity',
    });
  }

  const row = findRoute(routes, from, to);
  if (row) {
    const exercised = row.exercisedByLiveVenue === true;
    return emit({
      from,
      to,
      route: 'table',
      bridged: true,
      // Origin confirmation is not destination arrival.
      nonAtomic: true,
      estBps: Object.freeze(parseDecimal(row.estBps)),
      estMinutes: row.estMinutes,
      costAccounted: true,
      confidence: 'estimate',
      exercisedByLiveVenue: exercised,
      forwardLooking: !exercised,
      reason: null,
      evidence: { knownFrom: true, knownTo: true },
      source: 'fixtures/bridge_routes.json',
    });
  }

  // Unknown. Do not guess. A fabricated bridge estimate would silently reorder a ranking.
  const known = chainsOf(routes);
  const knownFrom = known.has(from);
  const knownTo = known.has(to);
  return emit({
    from,
    to,
    route: 'unknown',
    bridged: true,
    nonAtomic: true,
    estBps: null,
    estMinutes: null,
    costAccounted: false,
    confidence: null,
    exercisedByLiveVenue: false,
    forwardLooking: false,
    reason: knownFrom && knownTo ? 'unknown-chain-pair' : 'unknown-chain',
    evidence: { knownFrom, knownTo },
    source: null,
  });
}

/**
 * Contract check for a bridge estimate. The nonAtomic flag is structurally impossible to omit
 * or to falsify on a bridged leg.
 */
export function validateBridgeEstimate(estimate) {
  if (!isRecord(estimate)) fail('bridgeEstimate', 'must be an object');

  if (estimate.kind !== BRIDGE_ESTIMATE_KIND) {
    fail('bridgeEstimate.kind', `must be ${BRIDGE_ESTIMATE_KIND}`);
  }
  if (estimate.label !== ESTIMATE_LABEL) {
    fail('bridgeEstimate.label', `must be ${ESTIMATE_LABEL} because nothing here is a quote`);
  }
  if (estimate.isQuote !== false) fail('bridgeEstimate.isQuote', 'must be false');
  if (estimate.live !== false) fail('bridgeEstimate.live', 'must be false');

  requireChain(estimate.from, 'from');
  requireChain(estimate.to, 'to');
  if (!ROUTE_KINDS.has(estimate.route)) {
    fail('bridgeEstimate.route', `must be one of ${[...ROUTE_KINDS].join(', ')}`);
  }
  if (typeof estimate.bridged !== 'boolean') fail('bridgeEstimate.bridged', 'must be a boolean');

  if (!Object.hasOwn(estimate, 'nonAtomic')) {
    fail('bridgeEstimate.nonAtomic', 'is required on every bridge estimate');
  }
  if (typeof estimate.nonAtomic !== 'boolean') {
    fail('bridgeEstimate.nonAtomic', 'must be a boolean');
  }
  if (estimate.bridged && estimate.nonAtomic !== true) {
    fail(
      'bridgeEstimate.nonAtomic',
      'must be true for a bridged leg because origin confirmation is not destination arrival',
    );
  }
  if (!estimate.bridged && estimate.nonAtomic !== false) {
    fail('bridgeEstimate.nonAtomic', 'must be false when nothing moves');
  }

  if (typeof estimate.costAccounted !== 'boolean') {
    fail('bridgeEstimate.costAccounted', 'must be a boolean');
  }

  if (estimate.costAccounted) {
    if (!isFixed(estimate.estBps)) {
      fail('bridgeEstimate.estBps', 'must be a fixed point value when costAccounted is true');
    }
    if (!Number.isSafeInteger(estimate.estMinutes) || estimate.estMinutes < 0) {
      fail('bridgeEstimate.estMinutes', 'must be a nonnegative safe integer');
    }
    if (!CONFIDENCES.has(estimate.confidence)) {
      fail('bridgeEstimate.confidence', `must be one of ${[...CONFIDENCES].join(', ')}`);
    }
    if (estimate.reason !== null) {
      fail('bridgeEstimate.reason', 'must be null when the cost is accounted');
    }
  } else {
    // Unknown is not zero and it is certainly not a number.
    if (estimate.estBps !== null) {
      fail('bridgeEstimate.estBps', 'must be null when costAccounted is false');
    }
    if (estimate.estMinutes !== null) {
      fail('bridgeEstimate.estMinutes', 'must be null when costAccounted is false');
    }
    if (typeof estimate.reason !== 'string' || !MACHINE_REASON.test(estimate.reason)) {
      fail('bridgeEstimate.reason', 'must be a machine readable lower case code');
    }
    if (estimate.confidence !== null) {
      fail('bridgeEstimate.confidence', 'must be null when costAccounted is false');
    }
  }

  if (typeof estimate.exercisedByLiveVenue !== 'boolean') {
    fail('bridgeEstimate.exercisedByLiveVenue', 'must be a boolean');
  }
  if (typeof estimate.forwardLooking !== 'boolean') {
    fail('bridgeEstimate.forwardLooking', 'must be a boolean');
  }
  if (!isRecord(estimate.evidence)) fail('bridgeEstimate.evidence', 'must be an object');

  return estimate;
}

/**
 * The bps a caller may fold into a net of cost ranking, or null when there is no honest number.
 * A null here means the ranking must not silently treat the leg as free.
 */
export function netAdjustmentBps(estimate) {
  validateBridgeEstimate(estimate);
  return estimate.costAccounted ? estimate.estBps : null;
}

function unevaluated(reason) {
  return emit({
    from: 'unknown',
    to: 'unknown',
    route: 'unevaluated',
    bridged: true,
    nonAtomic: true,
    estBps: null,
    estMinutes: null,
    costAccounted: false,
    confidence: null,
    exercisedByLiveVenue: false,
    forwardLooking: false,
    reason,
    evidence: { knownFrom: false, knownTo: false },
    source: null,
    evaluated: false,
  });
}

/**
 * Annotate routes with reachability from a given chain. Purely additive: the annotation is
 * evidence beside the route, and it never rewrites the route's own costAccounted claim.
 * Callers fold reachability into ranking only when the user supplies a from chain.
 */
export function annotateReachability(routes, { fromChain = null, table } = {}) {
  if (!Array.isArray(routes)) fail('bridge.routes', 'must be an array');

  if (fromChain === null || fromChain === undefined) {
    const blank = unevaluated('no-from-chain');
    return routes.map((route) => ({ ...route, reachability: blank }));
  }

  requireChain(fromChain, 'fromChain');

  return routes.map((route) => {
    const destination = route?.chain;
    if (typeof destination !== 'string' || destination.length === 0) {
      return { ...route, reachability: unevaluated('no-destination-chain') };
    }
    const estimate = estimateBridge({ from: fromChain, to: destination, table });
    return { ...route, reachability: Object.freeze({ ...estimate, evaluated: true }) };
  });
}
