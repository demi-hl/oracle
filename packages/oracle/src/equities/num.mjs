const MAX_SCALE = 1000;
const TEN_THOUSAND = Object.freeze({ mantissa: 10000n, scale: 0 });

function assertScale(scale) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new RangeError(`scale must be a safe integer from 0 through ${MAX_SCALE}`);
  }
}

function fixed(mantissa, scale) {
  if (typeof mantissa !== 'bigint') {
    throw new TypeError('mantissa must be a bigint');
  }
  assertScale(scale);
  return Object.freeze({ mantissa, scale });
}

function assertFixed(value, name = 'value') {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${name} must be a fixed point value`);
  }
  if (typeof value.mantissa !== 'bigint') {
    throw new TypeError(`${name}.mantissa must be a bigint`);
  }
  assertScale(value.scale);
}

function pow10(scale) {
  assertScale(scale);
  return 10n ** BigInt(scale);
}

export function parseDecimal(value) {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError('value must be a plain decimal string');
  }

  const negative = value.startsWith('-');
  const unsigned = value[0] === '-' || value[0] === '+' ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  const mantissa = BigInt(digits) * (negative ? -1n : 1n);

  return fixed(mantissa, fraction.length);
}

export function fromScaledInteger(value, scale) {
  assertScale(scale);
  if (typeof value === 'bigint') {
    return fixed(value, scale);
  }
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value)) {
    throw new TypeError('value must be an integer string or bigint');
  }
  return fixed(BigInt(value), scale);
}

export function toString(value) {
  assertFixed(value);
  const negative = value.mantissa < 0n;
  const digits = (negative ? -value.mantissa : value.mantissa).toString();

  if (value.scale === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }

  const padded = digits.padStart(value.scale + 1, '0');
  const splitAt = padded.length - value.scale;
  return `${negative ? '-' : ''}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
}

export function rescale(value, targetScale) {
  assertFixed(value);
  assertScale(targetScale);

  if (targetScale === value.scale) {
    return fixed(value.mantissa, value.scale);
  }
  if (targetScale > value.scale) {
    return fixed(value.mantissa * pow10(targetScale - value.scale), targetScale);
  }
  return fixed(value.mantissa / pow10(value.scale - targetScale), targetScale);
}

function align(left, right) {
  assertFixed(left, 'left');
  assertFixed(right, 'right');
  const scale = Math.max(left.scale, right.scale);
  return [rescale(left, scale), rescale(right, scale), scale];
}

export function add(left, right) {
  const [a, b, scale] = align(left, right);
  return fixed(a.mantissa + b.mantissa, scale);
}

export function sub(left, right) {
  const [a, b, scale] = align(left, right);
  return fixed(a.mantissa - b.mantissa, scale);
}

export function mul(left, right) {
  assertFixed(left, 'left');
  assertFixed(right, 'right');
  const scale = left.scale + right.scale;
  assertScale(scale);
  return fixed(left.mantissa * right.mantissa, scale);
}

export function div(left, right, resultScale = Math.max(left?.scale ?? 0, right?.scale ?? 0)) {
  assertFixed(left, 'left');
  assertFixed(right, 'right');
  assertScale(resultScale);
  if (right.mantissa === 0n) {
    throw new RangeError('division by zero');
  }

  const numerator = left.mantissa * pow10(right.scale + resultScale);
  const denominator = right.mantissa * pow10(left.scale);
  return fixed(numerator / denominator, resultScale);
}

export function cmp(left, right) {
  const [a, b] = align(left, right);
  if (a.mantissa < b.mantissa) return -1;
  if (a.mantissa > b.mantissa) return 1;
  return 0;
}

export function spreadBps(value, reference, resultScale = 8) {
  const delta = sub(value, reference);
  return div(mul(delta, TEN_THOUSAND), reference, resultScale);
}

export function applyBps(value, bps, resultScale = value?.scale ?? 0) {
  assertFixed(value);
  assertFixed(bps, 'bps');
  assertScale(resultScale);

  const factor = fixed(10000n * pow10(bps.scale) + bps.mantissa, bps.scale);
  return div(mul(value, factor), TEN_THOUSAND, resultScale);
}

export function formatUsd(value) {
  return `$${toString(rescale(value, 2))}`;
}
