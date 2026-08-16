import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Same approach and the same ΔE as customer-colour.test.js, and for the same
// reason: this project's tailwind.config.js re-tunes and ALIASES ramps, so the
// only way to know what a badge paints is to resolve its class through the real
// theme. `CMYK + Pantone` was `indigo`, which this config aliases to systemBlue
// — the hue reserved for "lit control". A name-only check saw an innocent
// "indigo" and shipped a badge painted #0A84FF.
import defaultColours from 'tailwindcss/colors.js';
import tailwindConfig from '../../client/tailwind.config.js';
import { RESERVED_HUES } from '../../client/src/lib/customerColour.js';

// These live in .jsx files, which hold JSX and cannot be imported by
// node --test. Read the literals out of the source instead — the point is to
// measure what ships, and the source is what ships.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(__dirname, '../../client/src/components/', f), 'utf8');
const INK = read('PrintColour.jsx');
const SET = read('SetType.jsx');

const mapIn = (src, name) => {
  const body = src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`))?.[1];
  assert.ok(body, `${name} not found — did it move or get renamed?`);
  return Object.fromEntries([...body.matchAll(/'([^']+)':\s*'([^']*)'/g)].map(([, k, v]) => [k, v]));
};
// SET_TYPE_META is keyed by bare identifiers and each value is an object; pull
// out the `chip` and `lit` strings per key.
//
// Returns PAIRS, never an object keyed by set type. `chip` and `lit` share
// their keys (gang, new_output, hold), so merging them into one object drops
// every `chip` value — and `chip` is exactly where the original byte-identical
// collision lived, which made an earlier version of this guard pass while the
// bug was reinstated. Keep it a list.
const setTypeTones = field =>
  [...SET.matchAll(new RegExp(`(\\w+):\\s*\\{[^}]*?${field}:\\s*'([^']*)'`, 'g'))]
    .map(([, k, v]) => [`${k}.${field}`, v]);

const over = tailwindConfig.theme.extend.colors;
const hexOf = cls => {
  const [, fam, shade] = cls.match(/^(?:bg|text|border|from|to)-([a-z]+)-(\d+)$/) || [];
  return over[fam]?.[shade] ?? defaultColours[fam]?.[shade] ?? null;
};
const classesOf = tone => tone.split(/\s+/).filter(c => hexOf(c));

// CIE76 ΔE — same implementation and same reasoning as customer-colour.test.js.
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

test('ink vs set type: the two axes never paint the same pill', () => {
  // THE REGRESSION GUARD. Three pairs were byte-identical and shipped that way:
  // gang == Pantone, new_output == CMYK, single == Offset. A card face showed a
  // Gang chip and a Pantone badge as literally the same pixels.
  const inkTones = Object.entries({ ...mapIn(INK, 'COLOUR_DOT'), ...mapIn(INK, 'PROCESS_DOT') });
  const setTones = [...setTypeTones('chip'), ...setTypeTones('lit')];
  // Both sides must be non-empty, or the double loop below asserts nothing.
  assert.ok(inkTones.length >= 6, `ink tones parsed ${inkTones.length} entries — the guard would pass vacuously`);
  assert.ok(setTones.length >= 6, `set-type tones parsed ${setTones.length} entries — the guard would pass vacuously`);
  // Every set type must contribute its ROW tag, not just its lit-filter tone.
  assert.ok(setTones.some(([k]) => k === 'gang.chip'), 'gang.chip missing — the original collision lived there');
  for (const [ink, iTone] of inkTones) {
    for (const [st, sTone] of setTones) {
      assert.notEqual(iTone, sTone, `ink "${ink}" and set-type "${st}" are the SAME class string: ${iTone}`);
    }
  }
});

test('ink vs set type: ink stays a NEUTRAL shell, so hue cannot collide at all', () => {
  // The structural fix: the ink axis carries its identity in a dot, not a tint.
  // If someone re-tints these pills the collision comes straight back, because
  // every pale tint is within a couple of ΔE of every other one.
  const shell = INK.match(/export const INK_SHELL = '([^']*)'/)?.[1];
  assert.ok(shell, 'INK_SHELL not found — the ink axis is meant to be a neutral shell');
  for (const cls of classesOf(shell)) {
    const hex = hexOf(cls).toLowerCase();
    for (const hue of RESERVED_HUES) {
      for (const shade of [50, 100, 200, 500, 700, 800]) {
        const rHex = hexOf(`bg-${hue}-${shade}`);
        if (rHex) assert.notEqual(hex, rHex.toLowerCase(), `INK_SHELL uses ${cls}, which is ${hue}-${shade}`);
      }
    }
  }
});

test('ink dots: no dot RENDERS as the lit-control blue', () => {
  const litBlue = hexOf('bg-blue-500');
  for (const [state, tone] of Object.entries({ ...mapIn(INK, 'COLOUR_DOT'), ...mapIn(INK, 'PROCESS_DOT') })) {
    for (const cls of classesOf(tone)) {
      assert.notEqual(hexOf(cls).toLowerCase(), litBlue.toLowerCase(),
        `${state} paints ${cls} = ${hexOf(cls)}, which IS the reserved "lit control" blue`);
    }
  }
});

test('ink dots: the three colour states are told apart, and so are the processes', () => {
  // Dots are SATURATED (-400/-500), which is the whole reason this works where
  // tints did not: at -50 every hue is near-white and indigo-50 sat ΔE 1.3 from
  // sky-50, below the ~2.3 an eye can catch.
  const JND = 2.3;
  for (const map of ['COLOUR_DOT', 'PROCESS_DOT']) {
    const dots = mapIn(INK, map);
    const states = Object.keys(dots);
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        // A gradient dot ("both") is judged on its first stop against the other
        // state's own colour — that stop is exactly the other single state.
        const a = classesOf(dots[states[i]]), b = classesOf(dots[states[j]]);
        const d = Math.max(...a.flatMap(x => b.map(y => deltaE(hexOf(x), hexOf(y)))));
        assert.ok(d > JND * 2,
          `"${states[i]}" and "${states[j]}" dots are only ΔE ${d.toFixed(1)} apart at their furthest stop`);
      }
    }
  }
});

test('ink dots: every class resolves in THIS project theme', () => {
  for (const map of ['COLOUR_DOT', 'PROCESS_DOT']) {
    for (const [state, tone] of Object.entries(mapIn(INK, map))) {
      const colourish = tone.split(/\s+/).filter(c => /^(?:bg|from|to)-[a-z]+-\d+$/.test(c));
      assert.ok(colourish.length > 0, `${map}.${state} carries no resolvable colour class`);
      for (const cls of colourish) assert.ok(hexOf(cls), `${map}.${state} uses ${cls}, which resolves to nothing`);
    }
  }
});

test('ink tones: the reserved-hue list still names blue — this guard depends on it', () => {
  assert.ok(RESERVED_HUES.includes('blue'),
    'RESERVED_HUES no longer reserves blue; revisit what "lit control" means before trusting the guards above');
});
