// The Artwork queue's action cells, as text.
//
// exporter.js resolves a cell as col.export(row) → nodeText(col.render(row)) →
// row[key], and nodeText NEVER RENDERS a component — it walks
// `node.props?.children`. Approvals renders <Toggle/>, Tooling renders
// <ToolingChip/>, Status renders <StatusBadge/>; none of them has children, so
// all three resolved to ''.
//
// Measured on the live queue before the fix: blank on 33 of 33 exported rows.
// Not only the gang rows — EVERY row. The gang-cell memory had recorded this as
// a gang-only fault, which understated it.
//
// A blank cell is a silent failure: nothing throws, the build passes, and the
// column looks perfect on screen. So each of these is pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  approvalExport, PLAN_SAVED_LABEL, statusExport, statusLabel, toolingExport, toolingGaps, toolingLabel,
} from '../../client/src/lib/artworkCells.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// One column definition out of the Artwork table.
function column(key) {
  const src = read('client/src/pages/Artwork.jsx');
  const at = src.indexOf(`{ key: '${key}',`);
  if (at < 0) return null;
  const next = src.indexOf('\n          { key: ', at + 1);
  return src.slice(at, next < 0 ? at + 1200 : next);
}

test('every Artwork cell that renders a COMPONENT carries an export', () => {
  // These three render Toggle / ToolingChip / StatusBadge — components with no
  // children, which nodeText cannot read.
  for (const key of ['appr', 'tooling', 'status']) {
    assert.match(column(key), /export:/,
      `the ${key} column renders a component; without export: it writes an EMPTY cell on every row`);
  }
});

test('the chip and the export use ONE spelling of a tooling gap', () => {
  // ToolingChip used to build its label inline. Two copies drift, and the export
  // is the copy nobody looks at.
  const src = read('client/src/pages/Artwork.jsx');
  assert.match(src, /const label = line\.tooling_ready \? '✓ Ready' : toolingLabel\(line\)/,
    'ToolingChip must take its words from lib/artworkCells.js');
  assert.doesNotMatch(src, /gaps\.map\(g => `\$\{g\.label\}/,
    'the gap wording is duplicated back into the page');
});

test('tooling names the gaps, and says Ready when there are none', () => {
  assert.equal(toolingLabel({ tooling_ready: true }), 'Ready');
  assert.equal(
    toolingLabel({ tooling: [
      { label: 'Die', hard: true, status: 'missing' },
      { label: 'Plate Set', hard: true, status: 'not_ready', zone: 'triage' },
    ] }),
    'Die missing · Plate Set not ready',
  );
  // A tool being MADE reads as at the maker, not merely "not ready".
  assert.equal(
    toolingLabel({ tooling: [{ label: 'Block', hard: true, status: 'not_ready', zone: 'making' }] }),
    'Block at maker',
  );
});

test('a soft requirement nobody registered is not a gap', () => {
  // Only a HARD requirement counts unless a soft one is explicitly not_ready —
  // the same filter the chip's colour uses.
  assert.deepEqual(toolingGaps({ tooling: [{ label: 'Shade Card', hard: false, status: 'pending' }] }), []);
  assert.equal(toolingGaps({ tooling: [{ label: 'Shade Card', hard: false, status: 'not_ready' }] }).length, 1);
});

test('a gang is approved only when EVERY carton on the sheet is', () => {
  // The sheet prints together; one unapproved member holds the run.
  const gang = ok => ({ _gang: [
    { artwork_customer_ok: true, artwork_qa_ok: true },
    { artwork_customer_ok: ok, artwork_qa_ok: ok },
  ] });
  assert.equal(approvalExport(gang(true)), 'Customer approved · QA approved');
  assert.equal(approvalExport(gang(false)), 'Customer pending · QA pending');
});

test('a locked row says so', () => {
  assert.equal(
    approvalExport({ artwork_customer_ok: true, artwork_qa_ok: true, artwork_locked: true }),
    'Customer approved · QA approved · locked',
  );
});

test('a saved-but-unlocked plan is not "pending", and uses the BADGE\u2019s words', () => {
  // The queue shows PlanSavedBadge rather than pending — a job in the artwork
  // queue with a saved setup is not an unplanned job. The export must not invent
  // a second phrase for it: somebody reading the workbook beside the screen
  // should not have to work out that two labels mean one thing.
  const badge = read('client/src/components/ui.jsx');
  assert.ok(badge.includes('Saved \u00b7<br />lock pending'), 'PlanSavedBadge reworded — realign PLAN_SAVED_LABEL');
  assert.equal(PLAN_SAVED_LABEL, 'Saved \u00b7 lock pending');
  assert.equal(statusLabel({ plan_draft: true, status: 'pending' }), PLAN_SAVED_LABEL);
  assert.equal(statusLabel({ status: 'in_production' }), 'In production');
  assert.equal(statusLabel({}), '—', 'a row with no status must not export "undefined"');
});

test('a gang whose members disagree says each, not the first', () => {
  assert.equal(statusExport({ _gang: [{ status: 'planned' }, { status: 'planned' }] }), 'Planned');
  assert.equal(statusExport({ _gang: [{ status: 'planned' }, { plan_draft: true }] }), `Planned | ${PLAN_SAVED_LABEL}`);
  assert.equal(
    toolingExport({ _gang: [
      { product_code: 'A-1', tooling_ready: true },
      { product_code: 'B-1', tooling: [{ label: 'Die', hard: true, status: 'missing' }] },
    ] }),
    'A-1: Ready | B-1: Die missing',
  );
});

test('no export returns an empty string for a plausible row', () => {
  // The whole failure mode is a silent blank.
  const row = { status: 'pending', tooling: [], artwork_customer_ok: false, artwork_qa_ok: false };
  for (const [name, fn] of [['approval', approvalExport], ['tooling', toolingExport], ['status', statusExport]]) {
    const value = fn(row);
    assert.ok(value && String(value).trim(), `${name} export is blank — the fault this file exists to prevent`);
  }
});
