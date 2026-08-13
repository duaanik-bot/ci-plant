import { test } from 'node:test';
import assert from 'node:assert/strict';
// Client-only helper (a display colour the server never computes), tested here
// because this is where the repo runs its unit tests — same as customerCode.
import { CUSTOMER_HUES, RESERVED_HUES, customerHue } from '../../client/src/lib/customerColour.js';
// The colours as the PROJECT defines them — this config re-tunes most of the
// Tailwind ramps to the Apple system palette and aliases some outright.
import defaultColours from 'tailwindcss/colors.js';
import tailwindConfig from '../../client/tailwind.config.js';

// The five customers actually carrying work in the plant queue, by the id the
// order rows join on. SGLS and SGB are the pair this whole feature exists for:
// "Swiss Garnier Life Sciences" and "Swiss Garniers Biotech Private Limited"
// read almost identically as text, and one is 4x the other's volume.
const SGB = 4, SGLS = 5, GALPHA = 6, PUREFLIX = 2, FLUENCE = 43, HERBOVEDA = 1;

test('customerHue: one customer, one colour — forever', () => {
  // Stability is the whole point: the planner learns "rose is SGLS". A hue that
  // moved between page loads would be worse than no colour at all.
  assert.equal(customerHue(SGLS).name, customerHue(SGLS).name);
  assert.deepEqual(customerHue(SGB), customerHue(SGB));
});

test('customerHue: keyed on the id, so a renamed customer keeps its colour', () => {
  // Fluence is stored as "Fluence Pharamceuticals Pvt. Ltd. " — misspelled, with
  // a trailing space. When someone fixes that the colour must not move, which is
  // why nothing here reads the name.
  const before = customerHue(FLUENCE);
  const after = customerHue(FLUENCE);
  assert.equal(before.name, after.name);
  // A string id (JSON round-trip) is the same customer as the number.
  assert.equal(customerHue('43').name, customerHue(43).name);
});

test('customerHue: the customers on the floor together are all told apart', () => {
  const live = [SGLS, SGB, GALPHA, PUREFLIX, FLUENCE].map(id => customerHue(id).name);
  assert.equal(new Set(live).size, live.length, `two live customers share a hue: ${live.join(', ')}`);
});

test('customerHue: the whole customer master lands on distinct hues', () => {
  const all = [HERBOVEDA, PUREFLIX, SGB, SGLS, GALPHA, FLUENCE].map(id => customerHue(id).name);
  assert.equal(new Set(all).size, all.length, `hue collision across the master: ${all.join(', ')}`);
});

test('customerHue: neighbouring ids contrast — ids are handed out consecutively', () => {
  // Customers created in one sitting get consecutive ids, so id-neighbours are
  // exactly the ones most likely to sit in the queue together. Adjacent slots
  // must therefore be far apart on the wheel, never two shades of one colour.
  for (let id = 0; id < CUSTOMER_HUES.length - 1; id++) {
    assert.notEqual(customerHue(id).name, customerHue(id + 1).name);
  }
  // The three biggest customers hold consecutive ids 4/5/6 — the case that
  // pushed this rule. None of the three may share a family with another.
  const trio = [customerHue(SGB).name, customerHue(SGLS).name, customerHue(GALPHA).name];
  assert.equal(new Set(trio).size, 3);
});

test('customerHue: every hue carries the classes the chip and the row need', () => {
  for (const hue of CUSTOMER_HUES) {
    assert.match(hue.dot, /^bg-/, `${hue.name} dot must be a bg- class`);
    assert.ok(hue.name.length > 0);
  }
});

// ── The colours as they actually RENDER ────────────────────────────────────
// Checking hue NAMES is not enough and once let a real bug through: this
// project's tailwind.config.js aliases `indigo` to systemBlue, so `bg-indigo-500`
// paints #0A84FF — the exact blue that means "lit control". A name check saw an
// innocent-looking "indigo"; only resolving the class through the real theme
// catches it. Everything below therefore measures rendered colour.

const hexOf = (() => {
  const over = tailwindConfig.theme.extend.colors;
  return cls => {
    const [, fam, shade] = cls.match(/^bg-([a-z]+)-(\d+)$/) || [];
    return over[fam]?.[shade] ?? defaultColours[fam]?.[shade] ?? null;
  };
})();

// CIE76 ΔE. Roughly: 2.3 is the smallest difference an eye can catch, so the
// floor of 25 below is a wide margin, not a hair's breadth.
function deltaE(hexA, hexB) {
  const lab = hex => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const [l1, a1, b1] = lab(hexA), [l2, a2, b2] = lab(hexB);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const MIN_DELTA_E = 25;

test('customerHue: every hue actually resolves to a colour', () => {
  for (const hue of CUSTOMER_HUES) {
    assert.ok(hexOf(hue.dot), `${hue.dot} resolves to nothing in this project's Tailwind theme`);
  }
});

test('customerHue: no hue RENDERS as a status colour, whatever it is called', () => {
  // The regression guard. `bg-indigo-500` would fail here, because it paints
  // the same hex as blue — exactly what the old name-only check missed.
  const reserved = RESERVED_HUES.map(name => [name, hexOf(`bg-${name}-500`)]);
  for (const hue of CUSTOMER_HUES) {
    const hex = hexOf(hue.dot);
    for (const [name, rHex] of reserved) {
      assert.notEqual(hex.toLowerCase(), rHex.toLowerCase(),
        `${hue.name} renders as ${name} (${hex}) — it IS a status colour`);
    }
  }
});

test('customerHue: every hue stays clear of all six status colours', () => {
  const reserved = RESERVED_HUES.map(name => [name, hexOf(`bg-${name}-500`)]);
  for (const hue of CUSTOMER_HUES) {
    const hex = hexOf(hue.dot);
    for (const [name, rHex] of reserved) {
      const d = deltaE(hex, rHex);
      assert.ok(d >= MIN_DELTA_E,
        `${hue.name} (${hex}) is only ΔE ${d.toFixed(1)} from ${name} (${rHex})`);
    }
  }
});

test('customerHue: no two customers can be mistaken for each other', () => {
  // The feature's actual job. If this fails, two companies wear the same dot.
  for (let i = 0; i < CUSTOMER_HUES.length; i++) {
    for (let j = i + 1; j < CUSTOMER_HUES.length; j++) {
      const a = CUSTOMER_HUES[i], b = CUSTOMER_HUES[j];
      const d = deltaE(hexOf(a.dot), hexOf(b.dot));
      assert.ok(d >= MIN_DELTA_E, `${a.name} and ${b.name} are only ΔE ${d.toFixed(1)} apart`);
    }
  }
});

test('customerHue: the pair this feature exists for is unmistakable', () => {
  // SGLS and SGB read almost identically as text. Their dots must not.
  const d = deltaE(hexOf(customerHue(SGLS).dot), hexOf(customerHue(SGB).dot));
  assert.ok(d >= 100, `SGLS and SGB are only ΔE ${d.toFixed(1)} apart — too close for the one pair that matters`);
});

test('customerHue: the palette wraps rather than running out', () => {
  const past = customerHue(CUSTOMER_HUES.length + 3);
  assert.ok(past, 'an id past the palette length still gets a hue');
  assert.equal(past.name, customerHue(3).name);
});

test('customerHue: no customer, no dot — the caller renders the dash', () => {
  assert.equal(customerHue(null), null);
  assert.equal(customerHue(undefined), null);
  assert.equal(customerHue(''), null);
  assert.equal(customerHue('not-a-number'), null);
});
