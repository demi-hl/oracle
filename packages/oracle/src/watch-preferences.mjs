/** Notification classes supported by Oracle watches. */
export const WATCH_CATEGORIES = Object.freeze([
  'price',
  'wallet',
  'risk',
  'execution',
  'security',
  'nft',
  'governance',
  'system',
]);

const CATEGORY_SET = new Set(WATCH_CATEGORIES);

function assertCategory(category) {
  if (!CATEGORY_SET.has(category)) {
    throw new TypeError(`Unknown watch category: ${String(category)}`);
  }
  return category;
}

function subscribedCategories(preferences = {}) {
  const categories = preferences.subscribedCategories ?? [];
  if (!Array.isArray(categories)) {
    throw new TypeError('subscribedCategories must be an array');
  }
  return categories;
}

/** New users receive no category notifications until they explicitly opt in. */
export function defaultPreferences() {
  return { subscribedCategories: [] };
}

/** Return a new preference value with exactly one notification class enabled. */
export function subscribe(preferences, category) {
  assertCategory(category);
  const current = subscribedCategories(preferences);
  if (current.includes(category)) return { ...preferences, subscribedCategories: [...current] };
  return { ...preferences, subscribedCategories: [...current, category] };
}

/** Return a new preference value with the requested notification class disabled. */
export function unsubscribe(preferences, category) {
  assertCategory(category);
  const current = subscribedCategories(preferences);
  return {
    ...preferences,
    subscribedCategories: current.filter((candidate) => candidate !== category),
  };
}

/** Create a direct watch. Notifications are opt-in independently for every watch. */
export function createWatch({ category, notify = false, ...watch } = {}) {
  assertCategory(category);
  if (typeof notify !== 'boolean') throw new TypeError('watch notify must be a boolean');
  return { ...watch, category, notify };
}

function isMatchingNotifyingWatch(alert, watch) {
  if (!watch || watch.notify !== true || watch.category !== alert.category) return false;
  if (alert.watchId !== undefined && watch.id !== alert.watchId) return false;
  return true;
}

/**
 * Decide whether an alert may be delivered. This function only describes policy;
 * it performs no scheduling or delivery.
 */
export function evaluateAlert(alert, preferences = defaultPreferences(), watch) {
  if (!alert || typeof alert !== 'object') throw new TypeError('alert must be an object');
  assertCategory(alert.category);

  if (subscribedCategories(preferences).includes(alert.category)) {
    return { deliver: true, reason: 'category-subscribed' };
  }
  if (isMatchingNotifyingWatch(alert, watch)) {
    return { deliver: true, reason: 'watch-opt-in' };
  }
  return { deliver: false, reason: 'not-subscribed' };
}

export function shouldDeliverAlert(alert, preferences, watch) {
  return evaluateAlert(alert, preferences, watch).deliver;
}
