/**
 * Decimal-safe helpers.
 *
 * All quantities (KG) and money amounts (INR) are handled internally as INTEGER
 * "units" of 1/100 (hundredths). 2.5 KG = 250 units, Rs 93 = 9300 units.
 * Integer arithmetic means no floating-point drift. Database columns are
 * DECIMAL(x, 2), so two decimal places is the exact precision we store.
 */

const MAX_QUANTITY_UNITS = 10000 * 100; // 10,000 KG per sale
const MAX_AMOUNT_UNITS = 100000000 * 100; // Rs 10 crore per sale

const NUMERIC_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Parses a number or numeric string into integer hundredths.
 * Returns { units } on success or { error: 'missing' | 'negative' | 'malformed' }.
 */
function parseUnits(raw) {
  if (raw === undefined || raw === null) return { error: 'missing' };
  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { error: 'malformed' };
    s = String(raw);
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else {
    return { error: 'malformed' };
  }
  if (s === '') return { error: 'missing' };
  if (/^-\d*\.?\d+$/.test(s)) return { error: 'negative' };
  if (!NUMERIC_RE.test(s)) return { error: 'malformed' };
  const [intPart, frac = ''] = s.split('.');
  return { units: Number(intPart) * 100 + Number((frac + '00').slice(0, 2)) };
}

/** 250 -> "2.50" (string safe to hand to Prisma Decimal columns). */
function unitsToString(units) {
  const whole = Math.floor(units / 100);
  const frac = String(units % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** 250 -> 2.5 */
function unitsToNumber(units) {
  return units / 100;
}

/** Prisma Decimal | string | number | bigint | null -> JS number (exact for 2dp values). */
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

/** Prisma Decimal -> integer hundredths (via string, so no float error). */
function toUnits(value) {
  const n = parseUnits(value === null || value === undefined ? '0' : value.toString());
  return n.units || 0;
}

module.exports = {
  MAX_QUANTITY_UNITS,
  MAX_AMOUNT_UNITS,
  parseUnits,
  unitsToString,
  unitsToNumber,
  toNumber,
  toUnits,
};
