import test from 'node:test';
import assert from 'node:assert/strict';
import { PRINT_COLOUR_FIELDS, printColourWarnings, derivedCounts, colourSummary } from './print-colour.js';

test('the spec fields are exported for the override allowlist', () => {
  for (const f of ['print_process', 'cmyk_colours', 'pantone_colours', 'pantone_codes',
                   'metallic_colours', 'metallic_details', 'print_instructions']) {
    assert.ok(PRINT_COLOUR_FIELDS.includes(f), `${f} missing`);
  }
});

test('an untouched legacy product still derives sensible counts', () => {
  // 300+ live rows look exactly like this: a type and a total, nothing else.
  assert.deepEqual(derivedCounts({ colour_type: 'CMYK', colors: 4 }),
    { cmyk: 4, pantone: 0, metallic: 0, total: 4 });
  assert.deepEqual(derivedCounts({ colour_type: 'CMYK + Pantone', colors: 6 }),
    { cmyk: 4, pantone: 2, metallic: 0, total: 6 });
  assert.deepEqual(derivedCounts({ colour_type: 'Pantone', colors: 2 }),
    { cmyk: 0, pantone: 2, metallic: 0, total: 2 });
});

test('typed counts always beat derivation', () => {
  assert.deepEqual(
    derivedCounts({ colour_type: 'CMYK + Pantone', colors: 6, cmyk_colours: 4, pantone_colours: 1, metallic_colours: 1 }),
    { cmyk: 4, pantone: 1, metallic: 1, total: 6 });
});

test('free-text colour types imported from the master still resolve', () => {
  // The master is a picker now; the rows imported before it was are not.
  assert.equal(derivedCounts({ colour_type: 'cmyk+pantone', colors: 5 }).cmyk, 4);
  assert.equal(derivedCounts({ colour_type: 'CMYK & Pantone', colors: 5 }).pantone, 1);
});

test('Pantone selected with no codes warns', () => {
  const w = printColourWarnings({ colour_type: 'Pantone', colors: 2 });
  assert.ok(w.some(x => x.code === 'PANTONE_NO_CODES'));
});

test('Pantone with codes does not warn', () => {
  const w = printColourWarnings({ colour_type: 'Pantone', colors: 2, pantone_codes: 'Pantone 186 C' });
  assert.ok(!w.some(x => x.code === 'PANTONE_NO_CODES'));
});

test('metallic process with no metallic colour named warns', () => {
  const w = printColourWarnings({ colour_type: 'CMYK', colors: 5, print_process: 'Offset + Metallic' });
  assert.ok(w.some(x => x.code === 'METALLIC_NO_DETAIL'));
});

test('a total that does not equal its parts warns', () => {
  const w = printColourWarnings({ colour_type: 'CMYK + Pantone', colors: 9, cmyk_colours: 4, pantone_colours: 2, metallic_colours: 0 });
  assert.ok(w.some(x => x.code === 'TOTAL_MISMATCH'));
});

test('a total that equals its parts does not warn', () => {
  const w = printColourWarnings({ colour_type: 'CMYK + Pantone', colors: 6, cmyk_colours: 4, pantone_colours: 2, metallic_colours: 0 });
  assert.ok(!w.some(x => x.code === 'TOTAL_MISMATCH'));
});

test('an INFERRED total never raises a mismatch — only typed parts can disagree', () => {
  const w = printColourWarnings({ colour_type: 'CMYK + Pantone', colors: 6 });
  assert.ok(!w.some(x => x.code === 'TOTAL_MISMATCH'));
});

test('metallic ink named while the process says plain Offset warns', () => {
  const w = printColourWarnings({ colour_type: 'CMYK', colors: 4, print_process: 'Offset', metallic_details: 'Metallic Gold' });
  assert.ok(w.some(x => x.code === 'METALLIC_WITHOUT_PROCESS'));
});

test('a Pantone code alone NEVER implies metallic', () => {
  // The whole point of splitting the two axes. 871 C looks gold and is not a
  // metallic ink; grouping it with metallic work is the bug this design fixes.
  const w = printColourWarnings({ colour_type: 'Pantone', colors: 2, pantone_codes: 'Pantone 871 C', print_process: 'Offset' });
  assert.ok(!w.some(x => x.code === 'METALLIC_WITHOUT_PROCESS'));
});

test('a blank product raises nothing — warnings are for filled-in intent', () => {
  assert.deepEqual(printColourWarnings({}), []);
  assert.deepEqual(printColourWarnings(null), []);
});

test('the summary reads the way the plant says it out loud', () => {
  assert.equal(colourSummary({ colour_type: 'CMYK', colors: 4 }), 'CMYK — 4 colours');
  assert.equal(colourSummary({ colour_type: 'CMYK + Pantone', colors: 6 }), 'CMYK + 2 Pantone — 6 colours');
  assert.equal(colourSummary({ colour_type: 'Pantone', colors: 1 }), 'Pantone — 1 colour');
  assert.equal(
    colourSummary({ colour_type: 'CMYK', colors: 5, print_process: 'Offset + Metallic', metallic_colours: 1 }),
    'CMYK + 1 Metallic — 5 colours');
  assert.equal(colourSummary({}), '—');
});

test('a named metallic ink is called by its NAME, not just counted', () => {
  // "CMYK + Metallic Gold — 5 colours" tells the press which ink to hang;
  // "CMYK + 1 Metallic" makes them go and look it up.
  assert.equal(
    colourSummary({ colour_type: 'CMYK', colors: 5, print_process: 'Offset + Metallic',
                    metallic_colours: 1, metallic_details: 'Metallic Gold (Pantone 871 C)' }),
    'CMYK + Metallic Gold — 5 colours');
});

// ── client twin parity ────────────────────────────────────────────────
// Every printing-colour surface in the app derives its counts on the CLIENT
// (badges, filter rails, the summary in a table cell) while exports, the
// traveler and any future server-side filter derive them here. If the two
// drift, one screen says "6 colours" and the sheet in the operator's hand says
// "5" — and nothing fails loudly. Same precedent as the boardMix and boardMath
// twin parity blocks.
import * as client from '../../client/src/lib/printColour.js';
import * as server from './print-colour.js';

test('client twin: exported surface matches the server module', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
});

test('client twin: identical output across the shapes the plant actually holds', () => {
  const cases = [
    {},                                                                     // never filled in
    { colour_type: 'CMYK', colors: 4 },                                     // the 300+ legacy rows
    { colour_type: 'Pantone', colors: 2 },
    { colour_type: 'Pantone', colors: 2, pantone_codes: 'Pantone 186 C, Pantone 286 C' },
    { colour_type: 'CMYK + Pantone', colors: 6 },
    { colour_type: 'CMYK + Pantone', colors: 6, cmyk_colours: 4, pantone_colours: 2 },
    // Fully specified metallic — the case the whole two-axis split exists for.
    { colour_type: 'CMYK + Pantone', colors: 7, cmyk_colours: 4, pantone_colours: 2,
      print_process: 'Offset + Metallic', metallic_colours: 1,
      metallic_details: 'Metallic Gold (Pantone 871 C)', pantone_codes: 'Pantone 186 C' },
    // Gold-LOOKING Pantone on plain offset: must never read as metallic.
    { colour_type: 'Pantone', colors: 1, pantone_codes: 'Pantone 871 C', print_process: 'Offset' },
    { colour_type: 'Metallic only', colors: 1, print_process: 'Metallic', metallic_details: 'Silver' },
    { colour_type: 'cmyk+pantone', colors: 5 },                             // free-text import
    { colors: 3 },                                                          // count, no type
    { colour_type: 'CMYK + Pantone' },                                      // type, no count
    { colour_type: 'CMYK', colors: 9, cmyk_colours: 4, pantone_colours: 2 }, // a mismatch
  ];
  for (const c of cases) {
    const where = JSON.stringify(c);
    assert.equal(client.colourTypeOf(c), server.colourTypeOf(c), `colourTypeOf ${where}`);
    assert.equal(client.processOf(c), server.processOf(c), `processOf ${where}`);
    assert.equal(client.totalColoursOf(c), server.totalColoursOf(c), `totalColoursOf ${where}`);
    assert.equal(client.cmykCountOf(c), server.cmykCountOf(c), `cmykCountOf ${where}`);
    assert.equal(client.pantoneCountOf(c), server.pantoneCountOf(c), `pantoneCountOf ${where}`);
    assert.equal(client.metallicCountOf(c), server.metallicCountOf(c), `metallicCountOf ${where}`);
    assert.equal(client.metallicNameOf(c), server.metallicNameOf(c), `metallicNameOf ${where}`);
    assert.equal(client.colourSummary(c), server.colourSummary(c), `colourSummary ${where}`);
    assert.equal(client.colourSearchText(c), server.colourSearchText(c), `colourSearchText ${where}`);
    assert.equal(client.colourBandOf(c), server.colourBandOf(c), `colourBandOf ${where}`);
    assert.deepEqual(client.derivedCounts(c), server.derivedCounts(c), `derivedCounts ${where}`);
    assert.deepEqual(client.printColourWarnings(c), server.printColourWarnings(c), `warnings ${where}`);
  }
});

test('client twin: the filter predicate agrees, including the empty-set "all" case', () => {
  const rows = [
    { colour_type: 'CMYK', colors: 4 },
    { colour_type: 'Pantone', colors: 2 },
    { colour_type: 'CMYK + Pantone', colors: 6, print_process: 'Offset + Metallic', metallic_details: 'Gold' },
  ];
  const filters = [
    { colour: new Set(), process: new Set(), band: new Set() },            // empty = all
    { colour: new Set(['Pantone', 'CMYK + Pantone']), process: new Set(), band: new Set() },
    { colour: new Set(), process: new Set(['Offset + Metallic']), band: new Set() },
    { colour: new Set(), process: new Set(), band: new Set(['5-6']) },
  ];
  for (const f of filters) {
    for (const r of rows) {
      assert.equal(client.matchesColourFilters(r, f), server.matchesColourFilters(r, f),
        `${JSON.stringify(r)} vs ${JSON.stringify({ c: [...f.colour], p: [...f.process], b: [...f.band] })}`);
    }
  }
  assert.deepEqual(client.colourFilterCounts(rows), server.colourFilterCounts(rows));
});

test('an empty filter set means ALL, never none', () => {
  // The bug this guards: `set.has(x)` on an empty Set is false for everything,
  // so a naive predicate would blank the whole board before anyone clicks.
  const row = { colour_type: 'CMYK', colors: 4 };
  assert.equal(server.matchesColourFilters(row, { colour: new Set(), process: new Set(), band: new Set() }), true);
  assert.equal(server.matchesColourFilters(row, {}), true);
});
