// Source numbers arrive from venue JSON as IEEE 754 doubles. The numeric core in
// src/num.mjs deliberately refuses JavaScript numbers, so every adapter needs one
// audited crossing point from approximate source data into exact fixed point.
//
// This module is that crossing point. It exists so the conversion is written once
// and tested once, rather than six adapters each inventing their own.
//
// Honesty boundary: converting a double to fixed point does NOT make it exact. It
// makes it EXACTLY REPRESENTED. The value still carries whatever error the venue
// and JSON parsing already introduced. Nothing here may be read as a precision
// upgrade. See docs/NUMERIC.md.

import { parseDecimal } from './num.mjs';

// Number.prototype.toString gives the shortest string that round trips back to the
// same double, which is the closest thing to source truth we can recover after
// JSON.parse. Its one problem is exponent notation, which parseDecimal rejects on
// purpose. So we expand it here rather than loosening the parser.
export function numberToDecimalString(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('value must be a finite number');
  }

  const text = String(value);
  if (!text.includes('e') && !text.includes('E')) return text;

  const [mantissaText, exponentText] = text.split(/[eE]/);
  const exponent = Number(exponentText);
  const negative = mantissaText.startsWith('-');
  const unsigned = negative ? mantissaText.slice(1) : mantissaText;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  // Decimal point currently sits after the whole part, then shifts by the exponent.
  const pointIndex = whole.length + exponent;

  let out;
  if (pointIndex <= 0) {
    out = `0.${'0'.repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    out = `${digits}${'0'.repeat(pointIndex - digits.length)}`;
  } else {
    out = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }

  return `${negative ? '-' : ''}${out}`;
}

// Convert an approximate source number to fixed point. Returns null for null,
// undefined, and non finite input so a missing venue field stays MISSING and
// forces costAccounted false downstream. A missing number must never become zero.
export function fromSourceNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    // Some venues publish decimal strings. Those are source truth, use them directly.
    return parseDecimal(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return parseDecimal(numberToDecimalString(value));
}

// Same as fromSourceNumber but throws instead of returning null. Use only where a
// field is structurally guaranteed by the fixture shape check.
export function requireSourceNumber(value, label) {
  const parsed = fromSourceNumber(value);
  if (parsed === null) {
    throw new TypeError(`${label} must be a finite source number`);
  }
  return parsed;
}
