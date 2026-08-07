import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bestEquityRoute,
  equityVenues,
  prepareEquityRoute,
  toJsonSafe,
} from '../src/equities/index.mjs';
import { main as equitiesMain } from '../bin/oracle-equities.mjs';

test('equityVenues lists all six adapters including HIP-3 and TON', () => {
  const v = equityVenues();
  const names = v.inventory.map((x) => x.venue);
  assert.equal(names.includes('hyperliquid_hip3'), true);
  assert.equal(names.includes('rh_uniswap'), true);
  assert.equal(names.includes('solana_xstocks'), true);
  assert.equal(names.includes('ton_stonfi'), true);
  assert.equal(v.custody, 'prepare-only');
  assert.equal(v.liveness.survivors > 0, true);
});

test('bestEquityRoute NVDA returns winner and bestPreparable split', () => {
  const r = bestEquityRoute({ ticker: 'NVDA', sizeUsd: '1000' });
  assert.equal(r.ticker, 'NVDA');
  assert.equal(typeof r.rankedOn, 'string');
  assert.notEqual(r.winner, null);
  assert.equal(Array.isArray(r.ranked), true);
  assert.equal(Array.isArray(r.excluded), true);
  assert.equal('bestPreparable' in r, true);
  // Prepare tier must never silently become the only answer when quote-only exists.
  if (r.bestPreparable) {
    assert.equal(r.bestPreparable.tier, 'prepare');
    assert.equal(r.bestPreparable.venue, 'rh_uniswap');
  }
});

test('bestEquityRoute SPY includes ton_stonfi somewhere in the answer set', () => {
  const r = bestEquityRoute({ ticker: 'SPY', sizeUsd: '500' });
  const venues = [
    ...(r.ranked || []).map((x) => x.venue),
    ...(r.excluded || []).map((x) => x.venue),
  ];
  assert.equal(venues.includes('ton_stonfi'), true);
});

test('prepareEquityRoute emits unsigned RH artifact with wallet signature required', () => {
  const out = prepareEquityRoute({
    ticker: 'NVDA',
    recipient: '0x1111111111111111111111111111111111111111',
    sizeUsd: '100',
  });
  assert.equal(out.ok, true);
  assert.equal(out.artifact.requiresWalletSignature, true);
  assert.equal(out.artifact.backendSigner, false);
  assert.equal(out.artifact.chainId, 4663);
  assert.equal(typeof out.artifact.to, 'string');
});

test('prepareEquityRoute refuses missing recipient', () => {
  assert.throws(() => prepareEquityRoute({ ticker: 'NVDA' }), /recipient/);
});

test('toJsonSafe stringifies bigints', () => {
  const r = bestEquityRoute({ ticker: 'NVDA', sizeUsd: '10' });
  const s = JSON.stringify(toJsonSafe(r));
  assert.equal(s.includes('bigint'), false);
  assert.equal(typeof JSON.parse(s).ticker, 'string');
});

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    const code = fn();
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

test('CLI equities venues prints inventory', () => {
  const { code, out } = capture(() => equitiesMain(['venues']));
  assert.equal(code, 0);
  assert.equal(out.includes('hyperliquid_hip3'), true);
  assert.equal(out.includes('ton_stonfi'), true);
});

test('CLI equities quote NVDA --json returns ranked envelope', () => {
  const { code, out } = capture(() =>
    equitiesMain(['quote', 'NVDA', '--size', '1000', '--json']),
  );
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.ticker, 'NVDA');
  assert.notEqual(result.winner, null);
});
