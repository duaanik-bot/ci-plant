// The PO form previews the merge; the server writes it. They are two files, so
// they can drift — the client plate-rate twin drifted once and mispriced. These
// fixtures go through both and must come out identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidate as server } from './po-consolidate.js';
import { consolidate as client, mergeSummary } from '../../client/src/lib/poConsolidate.js';

const FIXTURES = [
  ['the requirement: A 20, B 10, A 10', [
    { material_id: 7, qty: 20, rate: 45, unit: 'packets', hsn_code: '4810', gst_rate: 18 },
    { material_id: 9, qty: 10, rate: 30, unit: 'packets', hsn_code: '4810', gst_rate: 18 },
    { material_id: 7, qty: 10, rate: 45, unit: 'packets', hsn_code: '4810', gst_rate: 18 },
  ]],
  ['nothing to merge', [
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 9, qty: 10, rate: 30 },
  ]],
  ['three of the same board', [
    { material_id: 7, qty: 5, rate: 45 },
    { material_id: 7, qty: 6, rate: 45 },
    { material_id: 7, qty: 7, rate: 45 },
  ]],
  ['rates disagree', [
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: 47 },
  ]],
  ['form strings, not numbers', [
    { material_id: '7', qty: '20', rate: '45' },
    { material_id: '7', qty: '10', rate: '' },
  ]],
  ['blank rows and a real one', [
    { material_id: '', qty: '' },
    { material_id: '', qty: '' },
    { material_id: 7, qty: 20, rate: 0 },
  ]],
  ['empty', []],
];

for (const [name, lines] of FIXTURES) {
  test(`server and client agree — ${name}`, () => {
    assert.deepEqual(client(lines), server(lines));
  });

  test(`server and client agree with a resolver — ${name}`, () => {
    const rate = sources => (sources[0].material_id == 7 ? 46.5 : null);
    assert.deepEqual(client(lines, { mergedRate: rate }), server(lines, { mergedRate: rate }));
  });
}

// mergeSummary is what the buyer reads before a direct PO goes through, so the
// numbers in it have to be the ones actually being written.
test('the summary names only what merged, and what it is being merged to', () => {
  const rows = client([
    { material_id: 7, qty: 20, rate: 45, unit: 'packets' },
    { material_id: 9, qty: 10, rate: 30, unit: 'packets' },
    { material_id: 7, qty: 10, rate: 47, unit: 'packets' },
  ]);
  const [only, ...rest] = mergeSummary(rows, id => `board ${id}`);
  assert.equal(rest.length, 0, 'the unmerged material says nothing');
  assert.equal(only.name, 'board 7');
  assert.equal(only.qty, 30);
  assert.equal(only.lineCount, 2);
  assert.equal(only.rate, 45, 'the top-most line wins on a direct PO');
  assert.deepEqual(only.positions, [1, 3], '1-based, as the buyer counts rows');
  assert.deepEqual(only.dropped, [{ position: 3, rate: 47 }], 'the rate that lost is named');
});

// The convert form quotes `estimates`, never the resolved rate: picking a vendor
// reprices the line afterwards, so a number named at open time would go stale on
// screen while the editor beside it showed something else.
test('estimates carry every rate asked for, winner included, deduped', () => {
  const rows = client([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: 47 },
    { material_id: 7, qty: 5, rate: 45 },
  ]);
  assert.deepEqual(mergeSummary(rows)[0].estimates, [45, 47]);
});

test('estimates ignore lines that named no rate at all', () => {
  const rows = client([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: '' },
  ]);
  assert.deepEqual(mergeSummary(rows)[0].estimates, [45], 'one estimate — nothing to warn about');
});

test('the summary reports no conflict when the rates already agree', () => {
  const rows = client([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: 45 },
  ]);
  assert.deepEqual(mergeSummary(rows)[0].dropped, []);
});

test('a blank rate is not a conflict — it was never a rival number', () => {
  const rows = client([
    { material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: '' },
  ]);
  assert.deepEqual(mergeSummary(rows)[0].dropped, []);
});

test('nothing merged, nothing to confirm', () => {
  assert.deepEqual(mergeSummary(client([{ material_id: 7, qty: 20 }])), []);
});
