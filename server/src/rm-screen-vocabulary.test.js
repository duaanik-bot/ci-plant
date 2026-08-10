import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ONE FIGURE, ONE NAME, EVERYWHERE IT IS PRINTED.
//
// The RM warehouse screen prints each stock figure in FOUR places, each a
// separate string literal: the row's column header, the KPI card above it, the
// filter notice when that card is clicked, and the PDF/XLSX summary. They are
// not derived from one another. Renaming three of the four is not a smaller
// version of this change — it is the failure mode, because the screen then uses
// two words for one number, which is the confusion the rebuild exists to end.
//
// So the old words are banned outright. A guard that greps for their absence
// cannot be satisfied by a partial rename.
const inv = readFileSync(new URL('../../client/src/pages/Inventory.jsx', import.meta.url), 'utf8');
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the retired stock vocabulary appears nowhere on the RM screen', () => {
  const src = code(inv);
  for (const [dead, alive] of [
    ['Available (Packets / Sheets)', 'On Shelf'],
    ['Committed (Planned)', 'Frozen'],
    ['Net Stock', 'Free to Promise'],
    ['Gross stock', 'On shelf'],
    ['Committed demand', 'Frozen for jobs'],
  ]) {
    assert.ok(!src.includes(dead),
      `"${dead}" is still on the screen — it must read "${alive}". Renaming some of the four `
      + 'places a figure is printed (row header, KPI card, filter notice, export summary) and '
      + 'not the others is the half-renamed screen this guard exists to prevent.');
  }
  for (const alive of ['On Shelf', 'Frozen', 'Free to Promise']) {
    assert.ok(src.includes(alive), `the new column label "${alive}" is missing`);
  }
});

// SHORTFALL GETS A COLUMN, AND STOPS BEING A BADGE.
//
// Today the red "+N over" span lives INSIDE the Frozen cell. The moment
// Shortfall becomes its own column, that span is the same number printed twice
// on one row — and the two would sit two columns apart, inviting the reader to
// add them. The badge must go in the same change the column arrives.
test('shortfall is a column, not a badge inside Frozen', () => {
  const src = code(inv);
  assert.ok(src.includes("label: 'Shortfall'"), 'the Shortfall column is missing');
  assert.ok(!/over<\/span>|\} over/.test(src),
    'the "+N over" badge is still rendered — with a Shortfall column present it prints the '
    + 'same figure twice on one row, two columns apart');
  // Whitespace-tolerant on purpose. The suffix this bans was multi-line JSX —
  // `...))} short` on one line, `</span>` on the next — so the flat literal
  // 'short</span>' never appeared in the file and an assertion spelled that way
  // passed before a single edit was made. It guarded nothing.
  //
  // Do NOT "tighten" this to /\} short\b/ either: the On Shelf column carries
  // `short={m.short}`, which that pattern matches, so it would fail on correct
  // code. Verified both ways against HEAD and the current file.
  assert.ok(!/short\s*<\/span>/.test(src),
    'the red "+N short" suffix is still on the Frozen KPI card sub-line — same duplication');
});
