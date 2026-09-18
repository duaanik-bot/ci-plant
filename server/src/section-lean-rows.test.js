// The station workspace sends each distinct traffic light once, and stops
// sending the queue fields no station screen reads.
//
// GET /floor/:section?completed=kpi was 590 KB decoded at die cutting on live
// prod (2026-09-18): 137 queue rows × ~104 keys. 190 KB of that was `light`
// written out once per row though only 11 distinct lights existed, and every
// tablet re-reads it on every realtime wave.
//
// The new bundle opts in with `fields=lean&lights=ref`:
//   lights=ref  every queue row's `light` becomes `light_ref`, an index into a
//               top-level `lights` array, in the SAME key position — the client
//               rehydrates in load(), before setData, so the search haystack
//               (rowMatches stringifies the row's values in key order) is what
//               it was.
//   fields=lean the queue rows shed QUEUE_LEAN_DROPS and full finished runs
//               shed COMPLETED_LEAN_DROPS — ids, positions, flags and stamps
//               the server has already consumed. Human-typed text and
//               quantities stay even where nothing draws them, because a
//               station search can reach any value on a row.
// Old bundles never send either param and must get today's bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { sectionPayload, completedRunsSql } from './routes/floor.js';
import {
  QUEUE_LEAN_DROPS, COMPLETED_LEAN_DROPS, withLeanRows, rehydrateSection, leanRowsAsked,
} from '../../client/src/lib/sectionLean.js';
import { COMPLETED_KPI_FIELDS } from '../../client/src/lib/sectionCompleted.js';

const wire = x => JSON.parse(JSON.stringify(x));

// The queue row's key order as the route emits it on live prod (die_cutting,
// 2026-09-18) — order is content for search, so the fixture keeps it.
const QUEUE_KEYS = ('id job_card_id seq stage status unit qty_in qty_out qty_scrap scrap_reason hold_reason machine_id '
  + 'pack_boxes pack_qty_per_box operator started_at completed_at qty_accepted qty_rejected qty_rework inspector remarks '
  + 'line_clearance inspected_at floor_pos jc_number order_line_id qty_planned sheets_issued queue_pos children_per_parent '
  + 'press_machine_id anchor_line_id line_remark product_id card_machine_id finalised_at ready_override ready_override_by '
  + 'ready_override_at ready_override_reason gang_run_id gang_number run_kind gang_members gang_run_mates product_name '
  + 'product_code party_item_code wip output_number run_output_number party_artwork_code coating special ups size gsm '
  + 'pasting_type colors colour_type print_process cmyk_colours pantone_colours pantone_codes metallic_colours '
  + 'metallic_details print_instructions child_l child_w board_name sheet_l sheet_w sheets_per_packet board_material_id '
  + 'board_grade die_number die_location customer_name po_number po_date delivery_date machine_name machine_model '
  + 'extra_issued_parents extra_issued_units open_xs open_xs_status open_xs_stage_qty latest_xs latest_xs_status '
  + 'latest_xs_stage_qty mix_cuts upstream_available extra_issued received expected_qty queue_state startable upstream '
  + 'board_state plate_state frozen_sheets light').split(' ');

const light = (state, note) => ({
  light: state, pct: 80, overridden: false, override: null, blockers: [],
  items: [
    { key: 'artwork', label: 'Artwork approved', state: 'ok', note: null, hard: true, tracked: true },
    { key: 'die', label: 'Die ready', state, note, hard: false, tracked: true },
  ],
});
const queueRow = (id, over = {}) => {
  const row = {};
  for (const k of QUEUE_KEYS) row[k] = null;
  return Object.assign(row, {
    id, job_card_id: 500 + id, seq: 7, stage: 'die_cutting', status: 'pending', unit: 'sheets',
    started_at: '2026-09-18T03:10:00.000Z', floor_pos: 2, queue_pos: 4, jc_number: `CI-JC-${id}`,
    anchor_line_id: 900 + id, card_machine_id: 3, finalised_at: '2026-09-12T10:00:00.000Z',
    ready_override: 0, po_date: '2026-08-30T18:30:00.000Z', extra_issued_parents: 0, extra_issued_units: 0,
    product_name: `Carton ${id}`, customer_name: 'Fluence', line_clearance: { checks: [{ label: 'Die cleaned', ok: true }] },
    remarks: 'watch the crease', inspector: 'Sunil',
    queue_state: 'queued', startable: true, upstream: { stage: 'embossing', status: 'completed' },
    light: light('pending', 'not registered'),
  }, over);
};
const QUEUE = [
  queueRow(1),
  queueRow(2, { light: light('pending', 'not registered') }),      // same light, separate object
  queueRow(3, { light: light('ok', null), ready_override: 1, ready_override_by: 'Anik',
    ready_override_reason: 'die on the machine' }),
  queueRow(4, { light: null }),                                    // no anchor line → no light
];
const completedRun = (id, over = {}) => ({
  id, job_card_id: 100 + id, seq: 7, stage: 'die_cutting', status: 'completed', unit: 'sheets',
  qty_in: 1000, qty_out: 980, qty_scrap: 20, scrap_reason: null, machine_id: 3, operator: 'Ramesh',
  started_at: '2026-09-17T02:00:00.000Z', completed_at: '2026-09-17T04:00:00.000Z',
  qty_accepted: null, qty_rejected: null, qty_rework: null, inspector: null, remarks: null,
  inspected_at: '2026-09-17T05:00:00.000Z', jc_number: `CI-JC-${id}`, press_machine_id: null,
  finalised_at: '2026-09-10T10:00:00.000Z', product_name: 'Q MET 500', die_location: 'Rack A3',
  yield_pct: 98, wastage_pct: 2, duration_min: 120, ...over,
});
const COMPLETED = [completedRun(1), completedRun(2, { operator: 'Suresh', machine_id: 4 })];
const PARTS = {
  section: 'die_cutting', kpis: { pending: 3 }, queue: QUEUE, completed: COMPLETED,
  audit: [{ id: 1, action: 'start' }], extraSheets: [], machines: [{ id: 3, name: 'Bobst' }],
};
const LEAN = { fields: 'lean', lights: 'ref' };

// What a row looks like once the lean keys are gone: same values, same order.
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

test('without the new params both of today’s responses are byte-identical', () => {
  for (const base of [{}, { completed: 'kpi' }]) {
    const legacy = JSON.stringify(sectionPayload(PARTS, base));
    for (const extra of [{}, { fields: '' }, { fields: 'LEAN' }, { fields: ['lean', 'lean'] },
      { lights: 'inline' }, { lights: ['ref', 'ref'] }, { other: 'lean' }]) {
      assert.equal(JSON.stringify(sectionPayload(PARTS, { ...base, ...extra })), legacy,
        `${JSON.stringify({ ...base, ...extra })} must get today's response`);
    }
  }
});

test('lean + refs → wire → rehydrate is today’s response minus the dropped keys, in order', () => {
  for (const base of [{}, { completed: 'kpi' }]) {
    const today = wire(sectionPayload(PARTS, base));
    const back = rehydrateSection(wire(sectionPayload(PARTS, { ...base, ...LEAN })));
    const expected = {
      ...today,
      queue: today.queue.map(r => without(r, QUEUE_LEAN_DROPS)),
      completed: base.completed === 'kpi' ? today.completed : today.completed.map(r => without(r, COMPLETED_LEAN_DROPS)),
    };
    assert.deepEqual(back, expected);
    // Key ORDER per row too — the search haystack is JSON.stringify(Object.values(row)).
    assert.equal(JSON.stringify(back.queue), JSON.stringify(expected.queue));
    assert.equal(JSON.stringify(back.completed), JSON.stringify(expected.completed));
    assert.equal('lights' in back, false, 'the lights table is consumed by rehydration');
  }
});

test('each distinct light travels once, rows point at it from the same key position', () => {
  const out = wire(sectionPayload(PARTS, { completed: 'kpi', ...LEAN }));
  assert.equal(out.lights.length, 2, 'four rows, two distinct lights, one row without');
  assert.doesNotMatch(JSON.stringify(out.queue), /"light":/);
  assert.deepEqual(out.queue.map(r => r.light_ref), [0, 0, 1, null]);
  for (const row of out.queue) {
    const keys = Object.keys(row);
    assert.equal(keys.at(-1), 'light_ref', 'light_ref sits where light sat');
    for (const k of QUEUE_LEAN_DROPS) assert.equal(k in row, false, `${k} must not travel`);
  }
  assert.equal(out.completed_rows, 'kpi');
});

test('each param works on its own', () => {
  const refsWire = wire(sectionPayload(PARTS, { lights: 'ref' }));
  assert.equal(refsWire.lights.length, 2, 'refs without the trim');
  assert.equal(refsWire.queue[0].seq, 7, 'refs alone drop no field');
  assert.deepEqual(rehydrateSection(refsWire), wire(sectionPayload(PARTS, {})));
  const leanOnly = wire(sectionPayload(PARTS, { fields: 'lean' }));
  assert.equal('lights' in leanOnly, false);
  assert.equal('seq' in leanOnly.queue[0], false, 'the trim without refs');
  assert.deepEqual(leanOnly.queue[0].light, wire(QUEUE[0].light));
  assert.equal(rehydrateSection(leanOnly), leanOnly, 'nothing to rehydrate');
});

test('rehydrate passes a response without a lights table straight through', () => {
  const legacy = wire(sectionPayload(PARTS, { completed: 'kpi' }));
  assert.equal(rehydrateSection(legacy), legacy);
  assert.equal(rehydrateSection(null), null);
});

test('interning never mutates the rows the route built', () => {
  const before = JSON.stringify(PARTS);
  sectionPayload(PARTS, LEAN);
  sectionPayload(PARTS, { completed: 'kpi', ...LEAN });
  assert.equal(JSON.stringify(PARTS), before);
});

// The drop lists, pinned. Growing either is a decision about what a tablet
// can still draw and find — make it here, with a reason, not in passing.
test('the lean drop lists are exactly these', () => {
  assert.deepEqual([...QUEUE_LEAN_DROPS], [
    // server-side inputs to the light, the lane order and the receipt, already consumed
    'seq', 'floor_pos', 'queue_pos', 'anchor_line_id', 'card_machine_id',
    'finalised_at', 'ready_override', 'ready_override_by', 'ready_override_at', 'ready_override_reason',
    'extra_issued_parents', 'extra_issued_units',
    // stamps with no reader on a queue row
    'started_at', 'inspected_at', 'po_date',
  ]);
  assert.deepEqual([...COMPLETED_LEAN_DROPS], ['finalised_at', 'inspected_at']);
});

// Every field a station reads off a queue row (the field trace), plus the text
// and quantities kept ONLY because search reaches them. None may be dropped.
const KEPT_ON_A_QUEUE_ROW = [
  'id', 'job_card_id', 'stage', 'status', 'unit', 'qty_in', 'qty_out', 'qty_scrap', 'scrap_reason', 'hold_reason',
  'machine_id', 'press_machine_id', 'operator', 'jc_number', 'order_line_id', 'gang_run_id', 'qty_planned',
  'sheets_issued', 'children_per_parent', 'line_remark', 'product_id', 'product_name', 'product_code',
  'party_item_code', 'party_artwork_code', 'gang_number', 'run_kind', 'gang_members', 'run_output_number',
  'gang_run_mates', 'wip', 'output_number', 'coating', 'special', 'ups', 'size', 'die_number', 'die_location',
  'colors', 'colour_type', 'print_process', 'cmyk_colours', 'pantone_colours', 'pantone_codes', 'metallic_colours',
  'metallic_details', 'print_instructions', 'child_l', 'child_w', 'board_name', 'board_grade', 'sheet_l', 'sheet_w',
  'sheets_per_packet', 'board_material_id', 'customer_name', 'po_number', 'delivery_date', 'machine_name',
  'machine_model', 'open_xs', 'open_xs_status', 'open_xs_stage_qty', 'latest_xs', 'latest_xs_status',
  'latest_xs_stage_qty', 'mix_cuts', 'upstream_available', 'received', 'expected_qty', 'extra_issued',
  'queue_state', 'startable', 'upstream', 'board_state', 'plate_state', 'frozen_sheets', 'light', 'completed_at',
  // no reader, kept because a station search can reach them (rowMatches)
  'gsm', 'pasting_type', 'line_clearance', 'inspector', 'remarks', 'qty_accepted', 'qty_rejected', 'qty_rework',
  'pack_boxes', 'pack_qty_per_box',
];
// The Completed tab's own reads (floor-section-payload.test.js pins the same
// list against COMPLETED_DROPS) plus the KPI projection.
const KEPT_ON_A_FINISHED_RUN = [
  'id', 'job_card_id', 'stage', 'seq', 'status', 'unit', 'qty_in', 'qty_out', 'qty_scrap', 'qty_planned',
  'sheets_issued', 'children_per_parent', 'yield_pct', 'wastage_pct', 'duration_min', 'scrap_reason',
  'operator', 'started_at', 'completed_at', 'machine_id', 'press_machine_id', 'card_machine_id', 'machine_name',
  'jc_number', 'output_number', 'run_output_number', 'gang_number', 'run_kind', 'gang_members', 'gang_run_id', 'wip',
  'product_id', 'product_name', 'product_code', 'party_item_code', 'party_artwork_code', 'line_remark', 'size', 'gsm',
  'ups', 'child_l', 'child_w', 'board_name', 'board_grade', 'customer_name', 'po_number', 'order_line_id',
  'anchor_line_id', 'inspector', 'remarks', 'qty_accepted', 'qty_rejected', 'qty_rework', 'die_location',
  ...COMPLETED_KPI_FIELDS,
];

test('no lean drop touches a field a station reads or searches', () => {
  assert.deepEqual(QUEUE_LEAN_DROPS.filter(f => KEPT_ON_A_QUEUE_ROW.includes(f)), []);
  assert.deepEqual(COMPLETED_LEAN_DROPS.filter(f => KEPT_ON_A_FINISHED_RUN.includes(f)), []);
  assert.equal(new Set(QUEUE_LEAN_DROPS).size, QUEUE_LEAN_DROPS.length);
});

// The source guard: no file a station screen loads may name a dropped field,
// except the few below that read it off something else. A new
// `row.started_at` in Section.jsx (or any component or lib it pulls in) fails
// here instead of drawing a blank on the floor.
const CLIENT = new URL('../../client/src/', import.meta.url).pathname;
const NOT_A_STATION_ROW = {
  // fed by GET /job-cards/:id (Section.jsx opens it by cardId), never by a row
  'components/JobCardSheet.jsx': ['finalised_at'],
  // product history — cannot open under /floor (lib/productHistoryAccess.js)
  'components/MasterHistory.jsx': ['seq', 'po_date'],
  // a local request counter named seq
  'components/Timeline.jsx': ['seq'],
  // OD columns for tables that declare a po_date column; Section declares none
  'lib/odDays.js': ['po_date'],
  // the lists themselves
  'lib/sectionLean.js': [...QUEUE_LEAN_DROPS, ...COMPLETED_LEAN_DROPS],
};
function importClosure(entry) {
  const seen = new Set();
  const stack = [path.join(CLIENT, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:import|from)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const p = path.resolve(path.dirname(f), m[1]);
      const hit = [p, `${p}.js`, `${p}.jsx`, `${p}/index.js`].find(c => existsSync(c) && statSync(c).isFile());
      if (hit) stack.push(hit);
    }
  }
  return [...seen].map(f => path.relative(CLIENT, f)).sort();
}

test('nothing a station screen loads reads a field the lean shape drops', () => {
  const files = importClosure('pages/Section.jsx');
  assert.ok(files.includes('pages/Section.jsx') && files.includes('components/Readiness.jsx')
    && files.includes('lib/operatorScope.js'), 'the closure walk found the station’s readers');
  const hits = [];
  for (const file of files) {
    const src = readFileSync(path.join(CLIENT, file), 'utf8');
    for (const field of new Set([...QUEUE_LEAN_DROPS, ...COMPLETED_LEAN_DROPS])) {
      if (!new RegExp(`\\b${field}\\b`).test(src)) continue;
      if ((NOT_A_STATION_ROW[file] || []).includes(field)) continue;
      hits.push(`${file} names ${field}`);
    }
  }
  assert.deepEqual(hits, [], 'a station reader names a field the lean rows no longer carry');
});

test('the station asks for lean rows on every tab', () => {
  assert.equal(withLeanRows('/floor/cutting'), '/floor/cutting?fields=lean&lights=ref');
  assert.equal(withLeanRows('/floor/cutting?completed=kpi'), '/floor/cutting?completed=kpi&fields=lean&lights=ref');
  assert.equal(leanRowsAsked({ fields: 'lean' }), true);
  for (const q of [{}, { fields: 'full' }, { fields: ['lean'] }, null]) assert.equal(leanRowsAsked(q), false);
});

test('Section.jsx asks for lean rows and rehydrates once per response, before setData', () => {
  const src = readFileSync(path.join(CLIENT, 'pages/Section.jsx'), 'utf8');
  assert.match(src, /api\.get\(withLeanRows\(sectionFloorPath\(section, tabRef\.current\)\)\)/);
  // api.get hands back the SAME object for identical bytes; a fresh rehydration
  // per poll would be a new object every time and re-render the whole station.
  assert.match(src, /if \(hydrated\.current\.res !== d\) hydrated\.current = \{ res: d, data: rehydrateSection\(d\) \}/);
  assert.match(src, /setData\(hydrated\.current\.data\)/);
  assert.doesNotMatch(src, /setData\(d\)/, 'a raw wire response must never reach the screen');
});

// ── (C) the KPI mode's finished runs, without the heavy view ────────────────
// With ?completed=kpi the 200 runs are reduced to eight fields; the lean bundle
// reads them through a query that selects only those, over the SAME row-
// deciding joins, filter, order and limit. Old bundles keep the full view.
test('only the lean KPI mode swaps the finished-runs query', () => {
  const heavy = completedRunsSql({});
  for (const q of [{}, { completed: 'kpi' }, { fields: 'lean' }, { lights: 'ref', fields: 'lean' },
    { completed: 'kpi', lights: 'ref' }, { completed: 'kpi', fields: 'LEAN' }])
    assert.equal(completedRunsSql(q), heavy, JSON.stringify(q));
  const lean = completedRunsSql({ completed: 'kpi', fields: 'lean', lights: 'ref' });
  assert.notEqual(lean, heavy);
  const norm = s => s.replace(/\s+/g, ' ').trim();
  // Every join that can DROP a row (inner joins, and the anchor line the orders
  // join reads through) must be in both, verbatim.
  for (const join of [
    'JOIN job_cards jc ON jc.id = js.job_card_id',
    'JOIN products p ON p.id = jc.product_id',
    'JOIN materials bm ON bm.id = p.board_material_id',
    'LEFT JOIN order_lines ol ON ol.id = jc.order_line_id',
    ') gol ON jc.order_line_id IS NULL',
    'JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)',
    'JOIN customers c ON c.id = o.customer_id',
  ]) {
    assert.ok(norm(heavy).includes(join), `heavy: ${join}`);
    assert.ok(norm(lean).includes(join), `lean: ${join}`);
  }
  // The order must be TOTAL (ORDER BY must end on a unique column): the two queries
  // have different join trees and so different plans, and on a completed_at tie at
  // the 200th row each would otherwise pick its own run — the Queue tab's KPIs and
  // the Completed tab's list would count different runs.
  const tail = "WHERE js.stage=$1 AND js.status='completed' ORDER BY js.completed_at DESC, js.id DESC LIMIT 200";
  assert.ok(norm(heavy).endsWith(tail) && norm(lean).endsWith(tail), 'same filter, same TOTAL order and limit');
  // …and it selects every field the KPI block, the press scope and the projection read.
  for (const f of [...COMPLETED_KPI_FIELDS, 'started_at'])
    assert.match(lean, new RegExp(`\\b${f}\\b`), `${f} must be selected`);
  assert.match(norm(lean), /COALESCE\(js\.operator, mcrew\.name\) AS operator/, 'operator falls back to the crew as before');
});
