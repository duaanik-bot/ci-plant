// One device, three men, three queues.
//
// All three press operators enter production against a single shared device and
// a single login. This module is what lets one of them say "I am Shiv Kumar" and
// have the screen answer with HIS press's queue — and, just as importantly, have
// his name land on what he records.
//
// A man's queue is HIS PRESS. That is forced by the data, not chosen for
// convenience: job_stages.operator is stamped only when a run STARTS, so
// filtering on the operator name would show a QUEUED job to nobody. The press is
// known from the moment Print Planning pins the card. The link from man to press
// is machine_operators — already the source of truth for the Start modal's crew
// picker and for the Press Line-up report's column headers.
//
// A printing employee with no press assignment therefore has no queue and gets
// no chip. Giving him one is an assignment in Masters -> Machines, not a code
// change, which keeps that screen the one place that says who runs what.
//
// Pure functions, no React, no direct DOM. Covered by
// server/src/operator-scope.test.js.

// Two stations, two different shapes of the same idea — because the plant is
// not the same shape everywhere.
//
// 'machine' — PRINTING ONLY. Print Planning pins a press days ahead and each
//   press has exactly ONE dedicated man, so a name IS a press. His queue is
//   knowable before he touches anything.
//
// 'pool' — COATING, DIE CUTTING, PASTING. The crew is shared: all five die men
//   are on all seven die machines, and NOTHING pins a job to a machine until
//   someone presses Start (verified against production: 0 of 100 open stages at
//   these three carried a machine). So a name cannot select a queue in advance.
//   Instead the man SELF-ASSIGNS by starting work, and his chip then shows
//   exactly what he has taken — nothing more. Free work lives under "All
//   operators", which is where he goes to pick some up.
//
// Widening this map is a plant decision, not a code cleanup. Same reasoning
// AUTO_ASSIGN_SECTIONS applies in runAssignment.js.
// 'sort-paste' is the PASTING station: /floor/pasting redirects there, because
// sorting and pasting were merged into one operator screen.
export const OPERATOR_PICKER = {
  printing: 'machine',
  coating: 'pool',
  die_cutting: 'pool',
  'sort-paste': 'pool',
};

// The employee sections whose crew may sign work at a station. Usually just
// itself; Sort & Paste is one screen spanning two.
export const CREW_SECTIONS = {
  'sort-paste': ['sorting', 'pasting'],
};
export const crewSectionsFor = section => CREW_SECTIONS[section] || [section];

export const pickerMode = section => OPERATOR_PICKER[section] || null;
export const hasOperatorPicker = section => !!pickerMode(section);

// Stations whose queue table drops the MACHINE column.
//
// At die cutting the machine is one of seven and is chosen at Start, so the
// column was empty on most rows — and worse, it used to fill with the JOB CARD's
// press ("Offset Printing Press No. 1") and make a free job look handed out.
//
// The OPERATOR column stays everywhere, including die cutting: once a man
// self-assigns, his name is exactly what the floor needs to see against the job.
// It can no longer lie — see shownOperator.
export const HIDES_MACHINE_COLUMN = ['die_cutting'];
export const showsMachineColumn = section => !HIDES_MACHINE_COLUMN.includes(section);

// The machine THIS stage is on — never another station's. `machine_name`
// COALESCEs to the job card's press, so on any non-printing station an unstarted
// row would name a press. The Start modal has always guarded this; the queue
// table did not.
export const ownMachineName = (r, section) =>
  ((r?.machine_id || section === 'printing') ? (r?.machine_name || null) : null);

// The name to SHOW in an Operator cell. At printing a queued job legitimately
// names the press's crew — that man will run it. Anywhere else only a started
// row has a real operator.
export const shownOperator = (r, section) =>
  (section === 'printing' ? (r?.operator || null) : ownerOf(r));

// Which states mean a man has actually TAKEN this job.
const CLAIMED_STATES = ['running', 'partial', 'hold'];

// Who holds this job, or null if it is still free for anyone.
//
// **Read ownership ONLY off a started row.** A pending row's `operator` is a
// server-side COALESCE that falls back to the crew of the JOB CARD's machine —
// which is the PRESS — so an unstarted die-cutting row cheerfully reports the
// press operator's name (the same trap runAssignment.js guards with `crew.some`).
// Trusting it would hand every die-cutting job to whoever runs Press 1.
// js.operator is really written the moment /start runs, and not before.
export const ownerOf = r =>
  (CLAIMED_STATES.includes(r?.queue_state) ? (r?.operator || null) : null);

// Ids cross the wire as numbers and come back out of storage as strings, so
// every comparison in here goes through one place. Null never matches anything —
// a job pinned to no press belongs to no operator.
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// The machine a stage row is ON: the machine it started on, else the press Print
// Planning pinned the card to. Identical to effectiveMachineId in
// server/src/routes/floor.js, which is how a press-scoped LOGIN is already
// scoped — the two must agree or the same job would belong to one press on the
// server and another on the screen.
export const rowMachineId = r => r?.machine_id ?? r?.press_machine_id ?? null;

// "Offset Printing Press No. 1 (5 Colour + Coater)" -> "P1". The chip has room
// for a man's full name or a press's full name, never both, and the name is the
// part he is looking for.
export function pressShort(machineName) {
  const n = String(machineName || '').match(/no\.?\s*(\d+)/i);
  if (n) return `P${n[1]}`;
  const digits = String(machineName || '').match(/(\d+)/);
  return digits ? `P${digits[1]}` : '';
}

// The rail's chips, in the shape that station's work actually takes.
//
// MACHINE mode — one chip per (press, crew member). A man on two presses gets
// two chips and each one means exactly one press, never a silent union, because
// "my queue" has to be a list he can work top-down. A press with no active crew
// contributes nothing: there is no one to name it after.
//
// POOL mode — one chip per MAN, because the machine is not his to be named
// after. Every name Masters knows for this station appears: the crews of its
// machines UNION the employees filed under it, so a man who is on the payroll
// for die cutting but not yet attached to a die machine can still sign his work.
export function operatorChips(machines, { mode = 'machine', employees, section } = {}) {
  if (mode === 'pool') {
    const want = new Set(crewSectionsFor(section));
    const seen = new Map();
    const add = name => {
      const n = String(name || '').trim();
      if (n && !seen.has(n)) seen.set(n, { key: `op:${n}`, name: n, mode: 'pool' });
    };
    for (const m of machines || []) for (const o of m.operators || []) add(o?.name);
    for (const e of employees || []) if (e?.active !== 0 && want.has(e?.section)) add(e?.name);
    return [...seen.values()];
  }
  const chips = [];
  for (const m of machines || []) {
    for (const o of m.operators || []) {
      const name = String(o?.name || '').trim();
      if (!name) continue;
      chips.push({
        key: `${m.id}:${name}`,
        name,
        machineId: m.id,
        machineName: m.name,
        short: pressShort(m.name),
        mode: 'machine',
      });
    }
  }
  return chips;
}

// The queue rows this man is responsible for. A null chip returns the list
// untouched — not a filtered copy, so the caller's own memo can tell the
// unfiltered case apart by identity.
//
// MACHINE mode: the jobs on his press.
//
// POOL mode: ONLY what this man has self-assigned. Not the free pool — a job
// nobody has started belongs to nobody, and it lives under "All operators",
// which is where a man goes to pick work up. Selecting a name answers one
// question and one only: what am I on right now? If he has taken nothing the
// list is empty, and that is the correct answer, not a failure.
//
// (An earlier cut showed unclaimed-plus-mine. Anik: "if I select an operator and
// no job is assigned to him, then no job should be there — only in all operators
// it should be there.")
export function rowsForOperator(rows, chip) {
  if (!chip) return rows || [];
  if (chip.mode === 'pool') return (rows || []).filter(r => ownerOf(r) === chip.name);
  return (rows || []).filter(r => sameId(rowMachineId(r), chip.machineId));
}

// Completed runs are a different question from queued work: a finished run has
// no pool, it was run by exactly one man on exactly one machine. So POOL mode
// asks "did HE run it", not "is it unclaimed" — an unclaimed completed run is a
// contradiction, and passing them through would show all five die men the same
// output figures.
export function runsForOperator(rows, chip) {
  if (!chip) return rows || [];
  if (chip.mode === 'pool') return (rows || []).filter(r => (r.operator || null) === chip.name);
  return (rows || []).filter(r => sameId(rowMachineId(r), chip.machineId));
}

// The section KPIs, recomputed over whatever subset is on screen.
//
// This MIRRORS the block in server/src/routes/floor.js (the `kpis` object in
// GET /floor/:section) line for line, over the very arrays the server counted.
// It exists because a strip reading "In Queue 10" above a three-row list is a
// lie — a KPI has to count the same way as the list beside it.
//
// When no operator is picked the caller passes the server's object through
// untouched instead of calling this, so the unfiltered numbers can never drift
// by so much as a rounding step.
export function kpisFor(queue, completed, now = new Date()) {
  const rows = queue || [];
  const done = completed || [];
  const today = done.filter(s => new Date(s.completed_at).toDateString() === now.toDateString());
  const sum = (list, k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  const pct = (list) => (sum(list, 'qty_in') > 0
    ? +(100 * sum(list, 'qty_out') / sum(list, 'qty_in')).toFixed(1)
    : null);
  return {
    pending: rows.filter(s => s.queue_state === 'queued').length,
    incoming: rows.filter(s => s.queue_state === 'incoming').length,
    running: rows.filter(s => ['running', 'partial'].includes(s.queue_state)).length,
    on_hold: rows.filter(s => s.queue_state === 'hold').length,
    completed_today: today.length,
    received_today: sum(today, 'qty_in'),
    produced_today: sum(today, 'qty_out'),
    scrap_today: sum(today, 'qty_scrap'),
    yield_today: pct(today),
    received_all: sum(done, 'qty_in'),
    produced_all: sum(done, 'qty_out'),
    scrap_all: sum(done, 'qty_scrap'),
    yield_all: pct(done),
  };
}

// ── Remembering the pick ──────────────────────────────────────────────────
//
// The pick lives on the DEVICE, not the login: it survives a reload and the 5s
// poll, and it is nobody's account setting.
//
// It is stamped with the day it was made and DROPPED on a new calendar day. The
// failure this prevents is the real one on a shop floor: the night man's name
// still on screen at 7am, quietly filing the morning's output under him. Losing
// a selection costs one tap; losing it silently costs a shift of wrong data.

export const storeKey = section => `ci.floor.${section}.operator`;
const dayStamp = (now) => now.toDateString();

// localStorage is absent in the test runner and can throw in a locked-down
// browser, so every touch goes through here and a failure is simply "no pick".
function safeStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch { return null; }
}

// Read back a pick and RESOLVE it against the chips that exist right now. A
// stored man who has since been taken off that press reads back as null rather
// than filtering the screen to a press that is no longer his.
export function readPick(section, chips, now = new Date(), store = safeStore()) {
  if (!store) return null;
  let raw;
  try { raw = JSON.parse(store.getItem(storeKey(section)) || 'null'); } catch { return null; }
  if (!raw?.key || raw.day !== dayStamp(now)) return null;
  return (chips || []).find(c => c.key === raw.key) || null;
}

export function writePick(section, chip, now = new Date(), store = safeStore()) {
  if (!store) return;
  try {
    if (chip) store.setItem(storeKey(section), JSON.stringify({ key: chip.key, day: dayStamp(now) }));
    else store.removeItem(storeKey(section));
  } catch { /* a full or locked store must never break the floor screen */ }
}
