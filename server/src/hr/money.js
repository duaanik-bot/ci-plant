// Exact money arithmetic. No JS float ever touches an amount.
//
// A Rat is a frozen {n, d}: BigInt numerator and denominator, d > 0n, lowest terms.
// make() is the only constructor, so those invariants hold for every Rat. Operands
// must be Rats: a raw number throws TypeError instead of becoming a NaN rational.
// Everything stays exact until toPaise() rounds a figure to paise.

const abs = (x) => (x < 0n ? -x : x);

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function make(n, d) {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') {
    throw new TypeError('money: operands must be Rats; wrap numbers and strings in rat()');
  }
  if (d === 0n) throw new RangeError('money: division by zero');
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(abs(n), d);
  return Object.freeze({ n: n / g, d: d / g });
}

const ZERO = make(0n, 1n);

// ── Parsing ───────────────────────────────────────────────────────────

const NOISE = /[\s,₹]|rs\.?/gi;                  // spaces, thousands commas, ₹, "Rs" and the dot after it
const DECIMAL = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i;

// Every JS number needs a shift of at most 324. Without a limit, a short text cell like
// '1e999999999' stalls the server for seconds expanding 10^shift (then throws RangeError).
const MAX_SHIFT = 1000n;

function parse(text) {
  const m = DECIMAL.exec(text.replace(NOISE, ''));
  if (!m || !(m[2] + m[3])) throw new TypeError(`rat: not a number: ${JSON.stringify(text)}`);
  const [, sign, wholePart, fracPart, exponent = '0'] = m;
  const digits = BigInt(wholePart + fracPart) * (sign === '-' ? -1n : 1n);
  const shift = BigInt(exponent) - BigInt(fracPart.length);       // value = digits × 10^shift
  if (shift > MAX_SHIFT || shift < -MAX_SHIFT) throw new TypeError(`rat: exponent out of range: ${JSON.stringify(text)}`);
  return shift >= 0n ? make(digits * 10n ** shift, 1n) : make(digits, 10n ** -shift);
}

// A number is read through String(), its shortest round-trip form, so 0.1 is exactly 1/10.
export function rat(value) {
  if (typeof value === 'bigint') return make(value, 1n);
  if (typeof value === 'number') return parse(String(value));
  if (typeof value === 'string') return parse(value);
  if (value && typeof value.n === 'bigint' && typeof value.d === 'bigint') return make(value.n, value.d);
  throw new TypeError(`rat: not a number: ${String(value)}`);
}

// ── Arithmetic and comparison ─────────────────────────────────────────

export const add = (a, b) => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => make(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => make(a.n * b.n, a.d * b.d);
export const div = (a, b) => make(a.n * b.d, a.d * b.n);          // a zero divisor makes d zero: RangeError
export const neg = (a) => make(-a.n, a.d);

// Everything below compares through sub(), so a raw number throws instead of answering wrongly.
export const cmp = (a, b) => {
  const { n } = sub(a, b);
  return n < 0n ? -1 : n > 0n ? 1 : 0;
};
export const isZero = (a) => cmp(a, ZERO) === 0;
export const isNeg = (a) => cmp(a, ZERO) < 0;
export const min = (a, b) => (cmp(a, b) <= 0 ? a : b);
export const max = (a, b) => (cmp(a, b) >= 0 ? a : b);

// ── Paise ─────────────────────────────────────────────────────────────

// n/d (d > 0) as a whole number, nearest, ties away from zero.
const roundHalfAway = (n, d) => {
  const q = (2n * abs(n) + d) / (2n * d);
  return n < 0n ? -q : q;
};

export const toPaise = (r) => roundHalfAway(r.n * 100n, r.d);
export const fromPaise = (p) => make(p, 100n);

// Paise rounded to the nearest whole rupee (ties away from zero, like toPaise), still in paise.
export const roundRupee = (p) => roundHalfAway(p, 100n) * 100n;

// ── Formatting ────────────────────────────────────────────────────────

// Truncates toward zero to `dp` places; never prints "-0.00".
export function fmtExact(r, dp = 6) {
  const scaled = (abs(r.n) * 10n ** BigInt(dp)) / r.d;
  const digits = scaled.toString().padStart(dp + 1, '0');
  const point = digits.length - dp;
  const text = dp > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return r.n < 0n && scaled !== 0n ? `-${text}` : text;
}

export const fmtPaise = (p) => fmtExact(fromPaise(p), 2);

const MAX_PLACES = 10;                           // where a value that never terminates is cut

// The shortest decimal that is exact: 10000, 86.37, 0.1, 0.30000000000000004. In lowest
// terms r terminates exactly when d has no prime factor but 2 and 5, and then it needs as
// many places as the larger of those two exponents. A value that never terminates
// (1/3, 22/7) is cut at MAX_PLACES by fmtExact.
export function fmtDecimal(r) {
  let rest = r.d;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) { rest /= 2n; twos++; }
  while (rest % 5n === 0n) { rest /= 5n; fives++; }
  return fmtExact(r, rest === 1n ? Math.max(twos, fives) : MAX_PLACES);
}
