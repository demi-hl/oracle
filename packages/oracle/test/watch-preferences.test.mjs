import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATCH_CATEGORIES,
  createWatch,
  defaultPreferences,
  evaluateAlert,
  subscribe,
  unsubscribe,
} from '../src/watch-preferences.mjs';

test('defaults are quiet for every notification category', () => {
  const preferences = defaultPreferences();

  assert.deepEqual(preferences, { subscribedCategories: [] });
  for (const category of WATCH_CATEGORIES) {
    assert.deepEqual(evaluateAlert({ category }, preferences), {
      deliver: false,
      reason: 'not-subscribed',
    });
  }
});

test('category opt-in is exact and does not mutate preferences', () => {
  const defaults = defaultPreferences();
  const preferences = subscribe(defaults, 'price');

  assert.deepEqual(defaults, { subscribedCategories: [] });
  assert.equal(evaluateAlert({ category: 'price' }, preferences).deliver, true);
  assert.equal(evaluateAlert({ category: 'wallet' }, preferences).deliver, false);
  assert.equal(evaluateAlert({ category: 'risk' }, preferences).deliver, false);
});

test('unsubscribe makes that category quiet again', () => {
  const subscribed = subscribe(defaultPreferences(), 'execution');
  const preferences = unsubscribe(subscribed, 'execution');

  assert.equal(evaluateAlert({ category: 'execution' }, preferences).deliver, false);
  assert.deepEqual(subscribed.subscribedCategories, ['execution']);
});

test('a direct watch can opt into only its matching alert category', () => {
  const watch = createWatch({ id: 'eth-target', category: 'price', notify: true });
  const preferences = defaultPreferences();

  assert.equal(
    evaluateAlert({ category: 'price', watchId: 'eth-target' }, preferences, watch).deliver,
    true,
  );
  assert.equal(
    evaluateAlert({ category: 'wallet', watchId: 'eth-target' }, preferences, watch).deliver,
    false,
  );
  assert.equal(
    evaluateAlert({ category: 'price', watchId: 'another-watch' }, preferences, watch).deliver,
    false,
  );
});

test('security-critical alerts do not enable broad notification spam', () => {
  const preferences = subscribe(defaultPreferences(), 'security');

  assert.equal(evaluateAlert({ category: 'security' }, preferences).deliver, true);
  for (const category of WATCH_CATEGORIES.filter((value) => value !== 'security')) {
    assert.equal(evaluateAlert({ category }, preferences).deliver, false);
  }
});
