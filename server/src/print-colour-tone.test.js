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

// COLOUR_TONE / PROCESS_TONE live in PrintColour.jsx, which holds JSX and so
// cannot be imported by node --test. Read the literals out of the source
// instead — the point is to measure what ships, and the source is what ships.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '../../client/src/components/PrintColour.jsx'), 'utf8');

const toneMap = name => {
  const body = SRC.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`))?.[1];
  assert.ok(body, `${name} not found in PrintColour.jsx — did it move or get renamed?`);
  return Object.fromEntries([...body.matchAll(/'([^']+)':\s*'([^']*)'/g)].map(([, k, v]) => [k, v]));
};

const over = tailwindConfig.theme.extend.colors;
const hexOf = cls => {
  const [, fam, shade] = cls.match(/^(?:bg|text|border)-([a-z]+)-(\d+)$/) || [];
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

test('ink tones: no ink badge RENDERS as the lit-control blue', () => {
  // The regression guard. `border-indigo-200 bg-indigo-50 text-indigo-700`
  // fails here even though nothing in it says "blue".
  const litBlue = hexOf('bg-blue-500');
  for (const [state, tone] of Object.entries({ ...toneMap('COLOUR_TONE'), ...toneMap('PROCESS_TONE') })) {
    for (const cls of classesOf(tone)) {
      assert.notEqual(hexOf(cls).toLowerCase(), litBlue.toLowerCase(),
        `${state} paints ${cls} = ${hexOf(cls)}, which IS the reserved "lit control" blue`);
    }
  }
});

test('ink tones: the three colour states are told apart at the tint that ships', () => {
  // A badge renders its bg-50/100, not its -500. indigo-50 sat ΔE 1.3 from
  // sky-50 — below the ~2.3 an eye can catch — so CMYK and CMYK + Pantone were
  // literally the same colour on screen while looking different in the source.
  const JND = 2.3;
  const tones = toneMap('COLOUR_TONE');
  const bg = s => hexOf(classesOf(tones[s]).find(c => c.startsWith('bg-')));
  const states = Object.keys(tones);
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const d = deltaE(bg(states[i]), bg(states[j]));
      assert.ok(d > JND * 2,
        `"${states[i]}" and "${states[j]}" render ΔE ${d.toFixed(1)} apart — too close to tell apart on a card`);
    }
  }
});

test('ink tones: every class in every tone resolves in THIS project theme', () => {
  for (const map of ['COLOUR_TONE', 'PROCESS_TONE']) {
    for (const [state, tone] of Object.entries(toneMap(map))) {
      const colourish = tone.split(/\s+/).filter(c => /^(?:bg|text|border)-[a-z]+-\d+$/.test(c));
      assert.ok(colourish.length > 0, `${map}.${state} carries no resolvable colour class`);
      for (const cls of colourish) {
        assert.ok(hexOf(cls), `${map}.${state} uses ${cls}, which resolves to nothing`);
      }
    }
  }
});

test('ink tones: the reserved-hue list still names blue — this guard depends on it', () => {
  assert.ok(RESERVED_HUES.includes('blue'),
    'RESERVED_HUES no longer reserves blue; revisit what "lit control" means before trusting the guard above');
});
