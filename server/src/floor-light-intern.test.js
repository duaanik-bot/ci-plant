// The Live Floor sends each distinct traffic light once.
//
// GET /floor was 1,651 KB decoded on live prod (2026-09-17), and 845 KB of it was
// `light` — 627 stage rows across 200 job cards carrying only 59 distinct light
// objects, each an eleven-item checklist with fixed labels. And that undercounts
// the repeats: a pinned row is written again under machines[].jobs, an unpinned
// one again under `unpinned`, because JSON has no references.
//
// `?lights=ref` sends `{ sections, lights }` with every row's `light` replaced by
// `light_ref`, an index into `lights`. The client rehydrates every row in all SIX
// containers — running, held, queued, incoming, machines[].jobs, unpinned —
// before anything reads it: JobRow, SectionBand and MachineBlock draw the dot
// from `job.light`, and the search haystack (rowMatches) stringifies the row's
// values, light included, so a lazily-rehydrated or half-rehydrated board would
// lose dots on machine tiles and change what search finds.
//
// Old bundles never send the param and must get today's bare array untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floorResponse } from './routes/floor.js';
import { internLights, rehydrateLights } from '../../client/src/lib/floorLights.js';

const light = (state, note) => ({
  state, label: state === 'green' ? 'Ready' : 'Waiting',
  items: [
    { key: 'artwork', label: 'Artwork approved', state: 'ok', note: null, tracked: true, hard: true },
    { key: 'board', label: 'Board issued', state, note, tracked: true, hard: false },
  ],
});
const GREEN = light('green', null);
const AMBER = light('amber', 'not applicable at cutting');

// Entries built the way the route builds them: one object per stage row, the
// SAME object reachable from a lane and from machines[].jobs or unpinned.
const entry = (id, over = {}) => ({
  stage_id: id, job_card_id: 500 + id, jc_number: `CI-JC-${id}`, stage: 'printing',
  gang_members: null, product_name: `Carton ${id}`, machine_id: null,
  light: { ...GREEN }, startable: true, state: 'queued', ...over,
});
function fixture() {
  const r1 = entry(1, { state: 'running', machine_id: 4, light: light('green', null) });
  const h1 = entry(2, { state: 'hold', machine_id: 4, light: light('amber', 'not applicable at cutting') });
  const q1 = entry(3, { light: light('green', null) });
  const q2 = entry(4, { light: null });                                   // no anchor line → no light
  const i1 = entry(5, { state: 'incoming', light: light('red', 'plates not ready'),
    gang_members: [{ line_id: 1, product_name: 'A' }, { line_id: 2, product_name: 'B' }] });
  const c1 = entry(6, { stage: 'cutting', state: 'queued', light: { ...AMBER } });
  return [
    {
      section: 'cutting', running: [], held: [], queued: [c1], incoming: [], extra_sheets_count: 2,
      machines: [], unpinned: [c1], unpinned_more: 0, today: { completed_today: 0 },
    },
    {
      section: 'printing', running: [r1], held: [h1], queued: [q1, q2], incoming: [i1], extra_sheets_count: 0,
      machines: [
        { id: 4, name: 'P1', live: 'running', today: { runs: 1, produced: 900 }, jobs: [r1, h1], more: 0 },
        { id: 5, name: 'P2', live: 'idle', today: { runs: 0, produced: 0 }, jobs: [], more: 0 },
      ],
      unpinned: [q1, q2, i1], unpinned_more: 0, today: { completed_today: 1 },
    },
    {
      section: 'qc', running: [], held: [], queued: [], incoming: [], extra_sheets_count: 0,
      machines: [], unpinned: [], unpinned_more: 0, today: { completed_today: 0 },
    },
  ];
}
const wire = x => JSON.parse(JSON.stringify(x));

test('intern → wire → rehydrate gives back the legacy payload byte for byte', () => {
  const legacy = fixture();
  const back = rehydrateLights(wire(internLights(legacy)));
  assert.deepEqual(back, wire(legacy));
  // Key ORDER too: the search haystack is JSON.stringify(Object.values(row)).
  assert.equal(JSON.stringify(back), JSON.stringify(legacy));
});

test('the wire form carries each distinct light once and no row carries a light', () => {
  const out = wire(internLights(fixture()));
  assert.ok(Array.isArray(out.sections) && Array.isArray(out.lights));
  assert.equal(out.lights.length, 3, 'six rows, three distinct lights: green, amber, red');
  assert.doesNotMatch(JSON.stringify(out.sections), /"light":/, 'every container is interned');
  const printing = out.sections[1];
  for (const row of [...printing.running, ...printing.held, ...printing.queued, ...printing.incoming,
    ...printing.machines.flatMap(m => m.jobs), ...printing.unpinned]) {
    assert.ok('light_ref' in row, `${row.jc_number} lost its light`);
  }
  assert.equal(printing.queued[1].light_ref, null, 'a row with no light stays without one');
});

test('interning never mutates the rows the route built', () => {
  const legacy = fixture();
  const before = JSON.stringify(legacy);
  internLights(legacy);
  assert.equal(JSON.stringify(legacy), before);
});

test('rehydrate passes an old server’s bare array straight through', () => {
  const legacy = wire(fixture());
  assert.equal(rehydrateLights(legacy), legacy);
});

test('/floor without ?lights=ref answers exactly what it always did', () => {
  const payload = fixture();
  for (const query of [{}, { lights: '' }, { lights: 'inline' }, { lights: ['ref', 'ref'] }])
    assert.equal(floorResponse(payload, query), payload, `query ${JSON.stringify(query)}`);
  assert.deepEqual(floorResponse(payload, { lights: 'ref' }), internLights(payload));
});

test('Floor.jsx asks for refs and rehydrates before the board is set', () => {
  const src = readFileSync(new URL('../../client/src/pages/Floor.jsx', import.meta.url), 'utf8');
  assert.match(src, /api\.get\('\/floor\?lights=ref'\)/);
  // Rehydrated BEFORE setSections — search, SectionBand and MachineBlock all read
  // job.light — and memoised on the response object: api.get hands back the SAME
  // object for unchanged bytes, and a fresh rehydration of it would re-render the
  // whole floor on every poll anyway.
  assert.match(src, /if \(hydrated\.current\.res !== res\) hydrated\.current = \{ res, secs: rehydrateLights\(res\) \}/);
  assert.match(src, /setSections\(hydrated\.current\.secs\)/);
  assert.doesNotMatch(src, /setSections\(res\)/, 'never the raw ref payload');
});
