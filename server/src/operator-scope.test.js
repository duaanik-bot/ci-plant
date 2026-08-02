import { test } from 'node:test';
import assert from 'node:assert/strict';
// Client-only module — tested from here because the server test runner is the
// only one in the repo. Same precedent as run-assignment.test.js.
import {
  hasOperatorPicker, pickerMode, crewSectionsFor, rowMachineId, pressShort, operatorChips,
  rowsForOperator, runsForOperator, ownerOf, kpisFor, readPick, writePick, storeKey,
} from '../../client/src/lib/operatorScope.js';

// The real presses and the real crew this is designed against.
const PRESS1 = { id: 8,  name: 'Offset Printing Press No. 1 (5 Colour + Coater)', operators: [{ id: 14, name: 'Shiv Kumar' }] };
const PRESS2 = { id: 9,  name: 'Offset Printing Press No. 2', operators: [{ id: 12, name: 'Dileep' }] };
const PRESS3 = { id: 13, name: 'Offset Printing Press No. 3', operators: [{ id: 28, name: 'Rahul Kumar' }] };
const PRESSES = [PRESS1, PRESS2, PRESS3];

const chipFor = name => operatorChips(PRESSES).find(c => c.name === name);

// ── which stations offer it ───────────────────────────────────────────────

test('printing scopes by MACHINE; the pooled stations scope by the man himself', () => {
  assert.equal(pickerMode('printing'), 'machine');
  assert.equal(pickerMode('coating'), 'pool');
  assert.equal(pickerMode('die_cutting'), 'pool');
});

test('pasting is keyed as sort-paste, because that is the page that renders it', () => {
  // /floor/pasting REDIRECTS to /floor/sort-paste (App.jsx) — sorting and
  // pasting were merged into one screen. Keying this on 'pasting' would put the
  // rail on a route nobody ever lands on.
  assert.equal(pickerMode('sort-paste'), 'pool');
  assert.equal(pickerMode('pasting'), null);
});

test('the Sort & Paste rail draws from BOTH crews — it is one screen over two stages', () => {
  assert.deepEqual(crewSectionsFor('sort-paste'), ['sorting', 'pasting']);
  assert.deepEqual(crewSectionsFor('coating'), ['coating']);
  const employees = [
    { id: 26, name: 'Dileep Pasting', section: 'pasting', active: 1 },
    { id: 27, name: 'Shankar', section: 'sorting', active: 1 },
    { id: 5, name: 'Rajesh', section: 'die_cutting', active: 1 },
  ];
  const chips = operatorChips([], { mode: 'pool', employees, section: 'sort-paste' });
  assert.deepEqual(chips.map(c => c.name), ['Dileep Pasting', 'Shankar']);
});

test('stations with no picker at all', () => {
  assert.equal(hasOperatorPicker('printing'), true);
  assert.equal(hasOperatorPicker('die_cutting'), true);
  assert.equal(hasOperatorPicker('cutting'), false);
  assert.equal(hasOperatorPicker('qc'), false);
  assert.equal(pickerMode('cutting'), null);
});

// ── chips ─────────────────────────────────────────────────────────────────

test('one chip per crewed press, in machine order', () => {
  const chips = operatorChips(PRESSES);
  assert.deepEqual(chips.map(c => c.name), ['Shiv Kumar', 'Dileep', 'Rahul Kumar']);
  assert.deepEqual(chips.map(c => c.machineId), [8, 9, 13]);
  assert.deepEqual(chips.map(c => c.short), ['P1', 'P2', 'P3']);
});

test('a press with no assigned crew contributes no chip — there is no one to name it after', () => {
  const bare = { id: 21, name: 'Offset Printing Press No. 4', operators: [] };
  const chips = operatorChips([...PRESSES, bare]);
  assert.equal(chips.length, 3);
  assert.equal(chips.some(c => c.machineId === 21), false);
});

test('Modi is printing crew with no press, so he never reaches the rail', () => {
  // He exists in employees; he is simply on no machine_operators row. The rail
  // is built from machines, so he cannot appear — and must not, because under
  // "my queue is my press" he has no queue.
  const chips = operatorChips(PRESSES);
  assert.equal(chips.some(c => c.name === 'Modi'), false);
});

test('two men on one press yield two chips, both pointing at that press', () => {
  const shared = { id: 9, name: 'Offset Printing Press No. 2', operators: [{ id: 12, name: 'Dileep' }, { id: 13, name: 'Modi' }] };
  const chips = operatorChips([shared]);
  assert.equal(chips.length, 2);
  assert.deepEqual(chips.map(c => c.machineId), [9, 9]);
  assert.notEqual(chips[0].key, chips[1].key);
});

test('a blank or missing crew name is skipped rather than drawn as an empty chip', () => {
  const messy = { id: 9, name: 'Press 2', operators: [{ id: 1, name: '  ' }, { id: 2, name: null }, { id: 3, name: ' Dileep ' }] };
  const chips = operatorChips([messy]);
  assert.deepEqual(chips.map(c => c.name), ['Dileep']);
});

test('operatorChips survives a page that has not loaded yet', () => {
  assert.deepEqual(operatorChips(null), []);
  assert.deepEqual(operatorChips([{ id: 1, name: 'X' }]), []);
});

test('pressShort reads the press number, and stays empty when there is none', () => {
  assert.equal(pressShort('Offset Printing Press No. 1 (5 Colour + Coater)'), 'P1');
  assert.equal(pressShort('Offset Printing Press No. 3'), 'P3');
  assert.equal(pressShort('Heidelberg'), '');
});

// ── which rows are his ────────────────────────────────────────────────────

test('a started stage is on the machine it started on', () => {
  const rows = [{ id: 1, machine_id: 8, press_machine_id: 9 }];
  assert.deepEqual(rowsForOperator(rows, chipFor('Shiv Kumar')).map(r => r.id), [1]);
  assert.deepEqual(rowsForOperator(rows, chipFor('Dileep')).map(r => r.id), []);
});

test('a queued stage falls back to the press Print Planning pinned — which is the whole point', () => {
  // machine_id is NULL until a run starts. If this fell through, an operator
  // would see an empty queue and the feature would be worthless.
  const rows = [{ id: 2, machine_id: null, press_machine_id: 13 }];
  assert.deepEqual(rowsForOperator(rows, chipFor('Rahul Kumar')).map(r => r.id), [2]);
});

test('a job pinned to no press belongs to no operator', () => {
  const rows = [{ id: 3, machine_id: null, press_machine_id: null }];
  assert.deepEqual(rowsForOperator(rows, chipFor('Shiv Kumar')), []);
  assert.deepEqual(rowsForOperator(rows, chipFor('Dileep')), []);
  assert.deepEqual(rowsForOperator(rows, chipFor('Rahul Kumar')), []);
});

test('ids compare across the string/number boundary', () => {
  const rows = [{ id: 4, machine_id: '8', press_machine_id: null }];
  assert.deepEqual(rowsForOperator(rows, chipFor('Shiv Kumar')).map(r => r.id), [4]);
});

test('no pick is All presses — every row, order untouched', () => {
  const rows = [{ id: 1, press_machine_id: 8 }, { id: 2, press_machine_id: 9 }, { id: 3, press_machine_id: 13 }];
  assert.deepEqual(rowsForOperator(rows, null).map(r => r.id), [1, 2, 3]);
});

test('filtering preserves the queue order it was given — the serial is just position', () => {
  // Print Planning's order arrives already applied (orderBoard on the server).
  // Filtering must never re-sort, or S.No. would stop meaning "next off this
  // press".
  const rows = [
    { id: 10, press_machine_id: 8 }, { id: 11, press_machine_id: 9 },
    { id: 12, press_machine_id: 8 }, { id: 13, press_machine_id: 8 },
  ];
  assert.deepEqual(rowsForOperator(rows, chipFor('Shiv Kumar')).map(r => r.id), [10, 12, 13]);
});

test('rowMachineId is the same rule the server scopes a press login by', () => {
  assert.equal(rowMachineId({ machine_id: 8, press_machine_id: 9 }), 8);
  assert.equal(rowMachineId({ machine_id: null, press_machine_id: 9 }), 9);
  assert.equal(rowMachineId({}), null);
  assert.equal(rowMachineId(null), null);
});

// ── KPIs ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-01T18:00:00+05:30');
const dayOf = (d, h = 12) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00+05:30`).toISOString();

const QUEUE = [
  { id: 1, press_machine_id: 8,  queue_state: 'running' },
  { id: 2, press_machine_id: 8,  queue_state: 'queued' },
  { id: 3, press_machine_id: 8,  queue_state: 'incoming' },
  { id: 4, press_machine_id: 9,  queue_state: 'queued' },
  { id: 5, press_machine_id: 9,  queue_state: 'hold' },
  { id: 6, press_machine_id: 13, queue_state: 'partial' },
];
const COMPLETED = [
  { id: 20, press_machine_id: 8,  completed_at: dayOf('2026-08-01'), qty_in: 1000, qty_out: 950, qty_scrap: 50 },
  { id: 21, press_machine_id: 8,  completed_at: dayOf('2026-08-01'), qty_in: 2000, qty_out: 1960, qty_scrap: 40 },
  { id: 22, press_machine_id: 9,  completed_at: dayOf('2026-08-01'), qty_in: 500,  qty_out: 480,  qty_scrap: 20 },
  { id: 23, press_machine_id: 13, completed_at: dayOf('2026-07-28'), qty_in: 800,  qty_out: 760,  qty_scrap: 40 },
];

// The server's own block, copied verbatim from the `kpis` object in
// GET /floor/:section (server/src/routes/floor.js). If kpisFor ever drifts from
// this, the strip starts contradicting the list under it.
function serverKpis(queue, completed, now) {
  const today = completed.filter(s => new Date(s.completed_at).toDateString() === now.toDateString());
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    pending: queue.filter(s => s.queue_state === 'queued').length,
    incoming: queue.filter(s => s.queue_state === 'incoming').length,
    running: queue.filter(s => ['running', 'partial'].includes(s.queue_state)).length,
    on_hold: queue.filter(s => s.queue_state === 'hold').length,
    completed_today: today.length,
    received_today: sum(today, 'qty_in'),
    produced_today: sum(today, 'qty_out'),
    scrap_today: sum(today, 'qty_scrap'),
    yield_today: sum(today, 'qty_in') > 0 ? +(100 * sum(today, 'qty_out') / sum(today, 'qty_in')).toFixed(1) : null,
    received_all: sum(completed, 'qty_in'),
    produced_all: sum(completed, 'qty_out'),
    scrap_all: sum(completed, 'qty_scrap'),
    yield_all: sum(completed, 'qty_in') > 0 ? +(100 * sum(completed, 'qty_out') / sum(completed, 'qty_in')).toFixed(1) : null,
  };
}

test('over the full arrays, kpisFor reproduces the server exactly', () => {
  assert.deepEqual(kpisFor(QUEUE, COMPLETED, NOW), serverKpis(QUEUE, COMPLETED, NOW));
});

test('scoped to one press, the strip counts only that press', () => {
  const shiv = chipFor('Shiv Kumar');
  const k = kpisFor(rowsForOperator(QUEUE, shiv), rowsForOperator(COMPLETED, shiv), NOW);
  assert.equal(k.pending, 1);          // id 2
  assert.equal(k.incoming, 1);         // id 3
  assert.equal(k.running, 1);          // id 1
  assert.equal(k.on_hold, 0);          // press 2's hold is not his
  assert.equal(k.completed_today, 2);  // ids 20, 21
  assert.equal(k.received_today, 3000);
  assert.equal(k.produced_today, 2910);
  assert.equal(k.scrap_today, 90);
  assert.equal(k.yield_today, 97);
});

test('a partially-done job counts as running, exactly as the server counts it', () => {
  const rahul = chipFor('Rahul Kumar');
  const k = kpisFor(rowsForOperator(QUEUE, rahul), rowsForOperator(COMPLETED, rahul), NOW);
  assert.equal(k.running, 1);
  assert.equal(k.pending, 0);
});

test('a run completed on an earlier day stays out of today and inside lifetime', () => {
  const rahul = chipFor('Rahul Kumar');
  const k = kpisFor(rowsForOperator(QUEUE, rahul), rowsForOperator(COMPLETED, rahul), NOW);
  assert.equal(k.completed_today, 0);
  assert.equal(k.produced_today, 0);
  assert.equal(k.produced_all, 760);
  assert.equal(k.yield_all, 95);
});

test('yield is null, never NaN, when nothing was received', () => {
  const k = kpisFor([], [], NOW);
  assert.equal(k.yield_today, null);
  assert.equal(k.yield_all, null);
  assert.equal(k.produced_today, 0);
});

test('kpisFor survives the pre-load state', () => {
  const k = kpisFor(null, null, NOW);
  assert.equal(k.pending, 0);
  assert.equal(k.yield_all, null);
});

// ── remembering the pick ──────────────────────────────────────────────────

const fakeStore = (seed = {}) => {
  const map = { ...seed };
  return {
    getItem: k => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: k => { delete map[k]; },
    _map: map,
  };
};

test('a pick made today reads back intact', () => {
  const chips = operatorChips(PRESSES);
  const store = fakeStore();
  writePick('printing', chipFor('Dileep'), NOW, store);
  const back = readPick('printing', chips, NOW, store);
  assert.equal(back?.name, 'Dileep');
  assert.equal(back?.machineId, 9);
});

test('a pick made yesterday is dropped — the night man does not sign the morning shift', () => {
  const chips = operatorChips(PRESSES);
  const store = fakeStore();
  writePick('printing', chipFor('Dileep'), NOW, store);
  const tomorrow = new Date('2026-08-02T07:00:00+05:30');
  assert.equal(readPick('printing', chips, tomorrow, store), null);
});

test('a man taken off that press reads back as null, not as a stale filter', () => {
  const store = fakeStore();
  writePick('printing', chipFor('Rahul Kumar'), NOW, store);
  // Masters -> Machines: Rahul comes off Press 3.
  const after = operatorChips([PRESS1, PRESS2, { ...PRESS3, operators: [] }]);
  assert.equal(readPick('printing', after, NOW, store), null);
});

test('choosing All presses clears the stored pick', () => {
  const chips = operatorChips(PRESSES);
  const store = fakeStore();
  writePick('printing', chipFor('Shiv Kumar'), NOW, store);
  writePick('printing', null, NOW, store);
  assert.equal(store.getItem(storeKey('printing')), null);
  assert.equal(readPick('printing', chips, NOW, store), null);
});

test('corrupt storage reads as no pick instead of throwing on the floor screen', () => {
  const chips = operatorChips(PRESSES);
  assert.equal(readPick('printing', chips, NOW, fakeStore({ [storeKey('printing')]: '{not json' })), null);
  assert.equal(readPick('printing', chips, NOW, fakeStore({ [storeKey('printing')]: 'null' })), null);
});

test('a store that throws never breaks the page', () => {
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.equal(readPick('printing', operatorChips(PRESSES), NOW, hostile), null);
  assert.doesNotThrow(() => writePick('printing', chipFor('Dileep'), NOW, hostile));
});

test('each station remembers its own man', () => {
  assert.equal(storeKey('printing'), 'ci.floor.printing.operator');
  assert.notEqual(storeKey('printing'), storeKey('cutting'));
});

// ── POOLED STATIONS — coating, die cutting, pasting ───────────────────────
//
// The real plant, read off production 2026-08-01: all five die men are on all
// SEVEN die machines, both coating men are on BOTH coaters, and 0 of 100 open
// stages at these stations carried a machine_id. So a name cannot pick a queue
// in advance — the man self-assigns by starting work.

const DIE_CREW = [
  { id: 6, name: 'Birju' }, { id: 7, name: 'Lakhan' }, { id: 5, name: 'Rajesh' },
  { id: 9, name: 'Sonu Pandit' }, { id: 8, name: 'Surjeet' },
];
const DIE_MACHINES = [2, 33, 34, 4, 35, 36, 37].map((id, i) => ({
  id, name: `${i < 3 ? 'Automatic' : 'Manual'} Die Cutting Machine No. ${(i % 3) + 1}`, operators: DIE_CREW,
}));
const COATERS = [7, 32].map((id, i) => ({
  id, name: `UV / Drip-Off Varnish Machine No. ${i + 1}`,
  operators: [{ id: 3, name: 'Parkash' }, { id: 4, name: 'Raja' }],
}));
const poolChips = (machines, employees, section) =>
  operatorChips(machines, { mode: 'pool', employees, section });

test('five men on seven die machines make FIVE chips, not thirty-five', () => {
  const chips = poolChips(DIE_MACHINES, [], 'die_cutting');
  assert.deepEqual(chips.map(c => c.name), ['Birju', 'Lakhan', 'Rajesh', 'Sonu Pandit', 'Surjeet']);
  assert.equal(chips.every(c => c.mode === 'pool'), true);
  assert.equal(chips.every(c => c.machineId === undefined), true);
});

test('both coating men appear once, not once per coater', () => {
  assert.deepEqual(poolChips(COATERS, [], 'coating').map(c => c.name), ['Parkash', 'Raja']);
});

test('a man on the payroll for this station but attached to no machine still gets a chip', () => {
  // Pasting: "Manual Pasting" carries no crew, so a man filed under pasting in
  // Masters -> Employees must still be able to sign his work.
  const machines = [{ id: 1, name: 'Automatic Lock Bottom Pasting Machine', operators: [{ id: 26, name: 'Dileep Pasting' }] },
    { id: 38, name: 'Manual Pasting', operators: [] }];
  const employees = [
    { id: 26, name: 'Dileep Pasting', section: 'pasting', active: 1 },
    { id: 27, name: 'Shankar', section: 'pasting', active: 1 },
    { id: 5, name: 'Rajesh', section: 'die_cutting', active: 1 },
  ];
  const chips = poolChips(machines, employees, 'pasting');
  assert.deepEqual(chips.map(c => c.name), ['Dileep Pasting', 'Shankar']);
});

test('another station’s crew never leaks into this rail', () => {
  const employees = [{ id: 14, name: 'Shiv Kumar', section: 'printing', active: 1 }];
  assert.deepEqual(poolChips(COATERS, employees, 'coating').map(c => c.name), ['Parkash', 'Raja']);
});

test('an inactive employee is not offered a chip', () => {
  const employees = [{ id: 99, name: 'Left The Plant', section: 'coating', active: 0 }];
  assert.deepEqual(poolChips(COATERS, employees, 'coating').map(c => c.name), ['Parkash', 'Raja']);
});

// ── THE TRAP: a pending row's operator is the PRESS operator ──────────────

test('a PENDING row is unowned even though it reports a name', () => {
  // js.operator is NULL before Start, and the server COALESCEs to the crew of
  // the JOB CARD's machine — the PRESS. So this die-cutting row claims to be
  // Shiv Kumar's. Treating that as ownership would hand every unstarted job at
  // every station to whoever runs Press 1.
  assert.equal(ownerOf({ queue_state: 'queued', operator: 'Shiv Kumar' }), null);
  assert.equal(ownerOf({ queue_state: 'incoming', operator: 'Shiv Kumar' }), null);
});

test('a STARTED row is owned by the man on it — that name is really written', () => {
  assert.equal(ownerOf({ queue_state: 'running', operator: 'Rajesh' }), 'Rajesh');
  assert.equal(ownerOf({ queue_state: 'partial', operator: 'Birju' }), 'Birju');
  assert.equal(ownerOf({ queue_state: 'hold', operator: 'Surjeet' }), 'Surjeet');
});

test('ownerOf survives a row with no operator at all', () => {
  assert.equal(ownerOf({ queue_state: 'running', operator: null }), null);
  assert.equal(ownerOf(null), null);
});

// ── unclaimed-or-mine ─────────────────────────────────────────────────────

const DIE_QUEUE = [
  { id: 1, queue_state: 'queued', operator: 'Shiv Kumar' },              // free (press-fallback name)
  { id: 2, queue_state: 'running', operator: 'Rajesh' },                 // Rajesh took it
  { id: 3, queue_state: 'incoming', operator: 'Shiv Kumar' },            // free
  { id: 4, queue_state: 'running', operator: 'Birju' },                  // Birju took it
  { id: 5, queue_state: 'partial', operator: 'Rajesh' },                 // Rajesh, mid-count
  { id: 6, queue_state: 'hold', operator: 'Surjeet' },                   // Surjeet stopped it
  { id: 7, queue_state: 'queued', operator: null },                      // free
];
const rajesh = () => poolChips(DIE_MACHINES, [], 'die_cutting').find(c => c.name === 'Rajesh');

test('a pooled man sees everything unclaimed PLUS his own, and nobody else’s', () => {
  assert.deepEqual(rowsForOperator(DIE_QUEUE, rajesh()).map(r => r.id), [1, 2, 3, 5, 7]);
});

test('day one — nothing claimed yet — he sees the WHOLE pool, never an empty page', () => {
  const fresh = DIE_QUEUE.filter(r => ['queued', 'incoming'].includes(r.queue_state));
  assert.deepEqual(rowsForOperator(fresh, rajesh()).map(r => r.id), fresh.map(r => r.id));
});

test('a colleague’s running job drops off his screen — that is the point', () => {
  const ids = rowsForOperator(DIE_QUEUE, rajesh()).map(r => r.id);
  assert.equal(ids.includes(4), false);  // Birju's
  assert.equal(ids.includes(6), false);  // Surjeet's hold
});

test('pooled filtering preserves queue order', () => {
  assert.deepEqual(rowsForOperator(DIE_QUEUE, rajesh()).map(r => r.id), [1, 2, 3, 5, 7]);
});

test('no pick at a pooled station shows every job', () => {
  assert.deepEqual(rowsForOperator(DIE_QUEUE, null).map(r => r.id), [1, 2, 3, 4, 5, 6, 7]);
});

// ── completed runs ────────────────────────────────────────────────────────

const DIE_DONE = [
  { id: 20, operator: 'Rajesh', qty_in: 100, qty_out: 95 },
  { id: 21, operator: 'Birju', qty_in: 200, qty_out: 190 },
  { id: 22, operator: 'Rajesh', qty_in: 300, qty_out: 300 },
  { id: 23, operator: null, qty_in: 50, qty_out: 50 },
];

test('a finished run belongs to the man who ran it — never to the pool', () => {
  // Passing unclaimed runs through would show all five die men the same output.
  assert.deepEqual(runsForOperator(DIE_DONE, rajesh()).map(r => r.id), [20, 22]);
});

test('runsForOperator at printing still scopes by press, unchanged', () => {
  const rows = [{ id: 30, machine_id: 8 }, { id: 31, machine_id: null, press_machine_id: 9 }];
  assert.deepEqual(runsForOperator(rows, chipFor('Shiv Kumar')).map(r => r.id), [30]);
  assert.deepEqual(runsForOperator(rows, chipFor('Dileep')).map(r => r.id), [31]);
  assert.deepEqual(runsForOperator(rows, null).map(r => r.id), [30, 31]);
});

test('the KPI strip counts a pooled man’s own slice', () => {
  const k = kpisFor(rowsForOperator(DIE_QUEUE, rajesh()), runsForOperator(DIE_DONE, rajesh()), NOW);
  assert.equal(k.running, 2);      // ids 2 and 5 — running + partial
  assert.equal(k.pending, 2);      // ids 1 and 7
  assert.equal(k.incoming, 1);     // id 3
  assert.equal(k.on_hold, 0);      // Surjeet's hold is not his
  assert.equal(k.produced_all, 395);
});

// ── the printing rail is untouched by all of the above ────────────────────

test('printing chips still carry their press, and printing filtering is unchanged', () => {
  const chips = operatorChips(PRESSES);
  assert.deepEqual(chips.map(c => c.mode), ['machine', 'machine', 'machine']);
  assert.equal(chips[0].machineId, 8);
  const rows = [{ id: 1, machine_id: null, press_machine_id: 8, queue_state: 'queued', operator: 'Shiv Kumar' }];
  assert.deepEqual(rowsForOperator(rows, chipFor('Shiv Kumar')).map(r => r.id), [1]);
  assert.deepEqual(rowsForOperator(rows, chipFor('Dileep')).map(r => r.id), []);
});

test('a stored pooled pick resolves against pooled chips', () => {
  const store = fakeStore();
  const chips = poolChips(DIE_MACHINES, [], 'die_cutting');
  writePick('die_cutting', chips.find(c => c.name === 'Surjeet'), NOW, store);
  assert.equal(readPick('die_cutting', chips, NOW, store)?.name, 'Surjeet');
  // ...and drops if he leaves the station's crew.
  const without = poolChips(DIE_MACHINES.map(m => ({ ...m, operators: DIE_CREW.filter(o => o.name !== 'Surjeet') })), [], 'die_cutting');
  assert.equal(readPick('die_cutting', without, NOW, store), null);
});
