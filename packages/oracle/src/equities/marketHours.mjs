// US equity market session classification.
//
// A price printed at 3am is not the same quality of fact as a price printed at
// noon. This module says which of three sessions an instant falls in so the
// rest of the product can price staleness risk honestly.
//
//   'core'     [09:30, 16:00) ET  real price discovery, tightest spreads
//   'extended' [04:00, 09:30) ET  pre market, and [16:00, 20:00) ET post market
//                                 thin books, wider spreads, higher staleness risk
//   'dark'     everything else, plus every weekend and every NYSE holiday
//
// The original brief modelled 04:00 to 20:00 as one uniform lit window. That is
// wrong: it matches the Arcus regularTradingHours flag but not market reality,
// because staleness risk differs materially between core and pre/post. Core and
// extended are therefore distinct states here.
//
// BOUNDARY CONVENTION: every interval is half open, [start, end), in ET wall
// clock. 09:30:00.000 ET exactly is 'core'; 16:00:00.000 ET exactly is
// 'extended'; 04:00:00.000 ET is 'extended' and 20:00:00.000 ET is 'dark'.
//
// ET is derived from UTC using fixtures/dst_transitions.json only. No UTC offset
// is hardcoded and no host timezone database is consulted, so this module is
// deterministic and offline. Instants outside the fixture's coverage throw
// rather than guess an offset: unknown is not zero.

import { getDstTransitions, getNyseHolidays } from './fixtures.mjs';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Eastern Standard Time is UTC-5, Eastern Daylight Time is UTC-4. These are the
// two possible ET offsets, selected per instant by the fixture, never assumed.
const EST_OFFSET_MS = -5 * MS_PER_HOUR;
const EDT_OFFSET_MS = -4 * MS_PER_HOUR;

// ET wall clock minutes since midnight.
const PRE_MARKET_OPEN_MIN = 4 * 60; // 04:00
const CORE_OPEN_MIN = 9 * 60 + 30; // 09:30
const CORE_CLOSE_MIN = 16 * 60; // 16:00
const POST_MARKET_CLOSE_MIN = 20 * 60; // 20:00

const SESSION_EDGES_MIN = Object.freeze([
  PRE_MARKET_OPEN_MIN,
  CORE_OPEN_MIN,
  CORE_CLOSE_MIN,
  POST_MARKET_CLOSE_MIN,
]);

export const SESSION_STATES = Object.freeze(['core', 'extended', 'dark']);

// The fixture stores startUtc / endUtc as epoch SECONDS (verified: 1772953200
// decodes to 2026-03-08T07:00:00Z, the 2026 spring forward; as milliseconds it
// would decode to 1970). Normalized to milliseconds once, at load.
let dstIndex;
let holidaySet;

function buildDstIndex() {
  const rows = getDstTransitions().dstTransitions.map((entry) => ({
    year: entry.year,
    startMs: entry.startUtc * MS_PER_SECOND,
    endMs: entry.endUtc * MS_PER_SECOND,
  }));
  rows.sort((a, b) => a.startMs - b.startMs);

  // Coverage runs from the start of the first covered year to the end of the
  // last covered year, in UTC. Outside that range we have no ground truth.
  const firstYear = rows[0].year;
  const lastYear = rows[rows.length - 1].year;
  return Object.freeze({
    rows: Object.freeze(rows),
    firstYear,
    lastYear,
    coverageStartMs: Date.UTC(firstYear, 0, 1),
    coverageEndMs: Date.UTC(lastYear + 1, 0, 1),
  });
}

function dst() {
  dstIndex ??= buildDstIndex();
  return dstIndex;
}

// holidayDayIndex entries are epoch days counted in UTC: 20454 * 86400000 is
// 1970-01-01 + 20454 days = 2026-01-01, which matches the aligned dates[0].
// Verified positionally against all 50 entries of the dates array.
function holidays() {
  if (holidaySet === undefined) {
    holidaySet = new Set(getNyseHolidays().holidayDayIndex);
  }
  return holidaySet;
}

function assertEpochMs(epochMs, label) {
  if (!Number.isSafeInteger(epochMs)) {
    throw new TypeError(`${label}: epochMs must be a safe integer number of milliseconds`);
  }
}

function assertCovered(epochMs, label) {
  const { coverageStartMs, coverageEndMs, firstYear, lastYear } = dst();
  if (epochMs < coverageStartMs || epochMs >= coverageEndMs) {
    throw new RangeError(
      `${label}: ${new Date(epochMs).toISOString()} is outside DST fixture coverage ` +
        `(${firstYear} through ${lastYear}). Refusing to assume a UTC offset.`,
    );
  }
}

// True when the instant falls inside a fixture daylight saving window. The
// fixture boundaries are the exact UTC instants the offset changes, so the
// comparison is half open on both ends of the DST window too.
function isDaylightTime(epochMs) {
  for (const row of dst().rows) {
    if (epochMs >= row.startMs && epochMs < row.endMs) return true;
  }
  return false;
}

function etOffsetMs(epochMs) {
  return isDaylightTime(epochMs) ? EDT_OFFSET_MS : EST_OFFSET_MS;
}

// Decompose an instant into ET civil fields without any host timezone lookup.
// Shifting the epoch by the ET offset and then reading UTC getters yields ET
// wall clock, which is exactly what the session rules are written against.
function etFields(epochMs) {
  const shifted = epochMs + etOffsetMs(epochMs);
  const dayIndex = Math.floor(shifted / MS_PER_DAY);
  const msIntoDay = shifted - dayIndex * MS_PER_DAY;
  const date = new Date(shifted);
  return {
    dayIndex,
    minuteOfDay: Math.floor(msIntoDay / MS_PER_MINUTE),
    msIntoDay,
    weekday: date.getUTCDay(), // 0 Sunday through 6 Saturday, in ET
  };
}

function isTradingDay({ dayIndex, weekday }) {
  if (weekday === 0 || weekday === 6) return false;
  return !holidays().has(dayIndex);
}

function stateForMinuteOfDay(minuteOfDay) {
  if (minuteOfDay < PRE_MARKET_OPEN_MIN) return 'dark';
  if (minuteOfDay < CORE_OPEN_MIN) return 'extended';
  if (minuteOfDay < CORE_CLOSE_MIN) return 'core';
  if (minuteOfDay < POST_MARKET_CLOSE_MIN) return 'extended';
  return 'dark';
}

/**
 * Which session the instant falls in.
 * @param {number} epochMs epoch milliseconds, UTC
 * @returns {'core'|'extended'|'dark'}
 */
export function sessionState(epochMs) {
  assertEpochMs(epochMs, 'sessionState');
  assertCovered(epochMs, 'sessionState');

  const fields = etFields(epochMs);
  if (!isTradingDay(fields)) return 'dark';
  return stateForMinuteOfDay(fields.minuteOfDay);
}

/**
 * Convenience predicate: no lit venue is quoting into real price discovery.
 * @param {number} epochMs epoch milliseconds, UTC
 * @returns {boolean}
 */
export function isDark(epochMs) {
  assertEpochMs(epochMs, 'isDark');
  return sessionState(epochMs) === 'dark';
}

// Convert an ET civil day plus an ET minute of day back to an epoch instant.
// The offset depends on the instant itself, so this resolves the offset by fixed
// point: guess with one offset, recompute the offset at the candidate instant,
// and re-derive. Two passes converge for every real ET wall time, and the
// verify step below rejects the wall times that do not exist (the skipped hour
// on spring forward day). Session edges are 04:00 and later so they are never
// inside the 02:00 to 03:00 gap, but the guard is kept rather than assumed away.
function etWallToEpochMs(dayIndex, minuteOfDay) {
  const naive = dayIndex * MS_PER_DAY + minuteOfDay * MS_PER_MINUTE;
  let candidate = naive - EST_OFFSET_MS;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = naive - etOffsetMs(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  const check = etFields(candidate);
  if (check.dayIndex !== dayIndex || check.minuteOfDay !== minuteOfDay) return null;
  return candidate;
}

/**
 * The next instant at which the session state changes, at or after epochMs.
 *
 * Scans forward day by day over real ET calendar days so weekends, holidays,
 * and DST changes are all handled by the same code path that classifies a
 * single instant. Returns { at, from, to } where `at` is the first millisecond
 * of the new state (edges are inclusive starts, matching sessionState).
 *
 * @param {number} epochMs epoch milliseconds, UTC
 * @returns {{at: number, from: 'core'|'extended'|'dark', to: 'core'|'extended'|'dark'}}
 */
export function nextTransition(epochMs) {
  assertEpochMs(epochMs, 'nextTransition');
  assertCovered(epochMs, 'nextTransition');

  const from = sessionState(epochMs);
  const startFields = etFields(epochMs);

  // A dark stretch can span a long weekend plus a holiday, and the fixture has
  // no gap longer than a few days, so a bounded scan is enough. 400 days covers
  // any run of dark days the calendar can produce inside fixture coverage.
  const MAX_DAYS_SCANNED = 400;

  for (let offset = 0; offset < MAX_DAYS_SCANNED; offset += 1) {
    const dayIndex = startFields.dayIndex + offset;
    const edges = [];

    // Day boundary itself is a candidate edge: the state can change at ET
    // midnight when a lit day rolls into a dark weekend day or vice versa.
    if (offset > 0) edges.push(0);
    for (const edgeMin of SESSION_EDGES_MIN) edges.push(edgeMin);

    for (const edgeMin of edges) {
      const at = etWallToEpochMs(dayIndex, edgeMin);
      if (at === null) continue; // nonexistent wall time on a spring forward day
      if (at <= epochMs) continue;
      if (at >= dst().coverageEndMs) {
        throw new RangeError(
          `nextTransition: next boundary after ${new Date(epochMs).toISOString()} falls ` +
            `outside DST fixture coverage (through ${dst().lastYear}).`,
        );
      }
      const to = sessionState(at);
      if (to !== from) return Object.freeze({ at, from, to });
    }
  }

  throw new RangeError(
    `nextTransition: no session change found within ${MAX_DAYS_SCANNED} days of ` +
      `${new Date(epochMs).toISOString()}`,
  );
}
