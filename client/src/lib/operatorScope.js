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

// The only station that offers the picker. Widening this list is a plant
// decision, not a code cleanup — a station qualifies when its machines carry
// assigned crew AND its queue is pinned per machine ahead of time. Same
// reasoning AUTO_ASSIGN_SECTIONS applies in runAssignment.js.
export const OPERATOR_PICKER_SECTIONS = ['printing'];

export const hasOperatorPicker = section => OPERATOR_PICKER_SECTIONS.includes(section);

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

// One chip per (press, crew member). A man on two presses gets two chips and
// each one means exactly one press — never a silent union, because "my queue"
// has to be a list he can work top-down.
//
// Machine order is preserved (the route already sorts by name), and a press with
// no active crew contributes nothing: there is no one to name it after.
export function operatorChips(machines) {
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
      });
    }
  }
  return chips;
}

// The rows this man is responsible for. A null chip is "All presses" and returns
// the list untouched — not a filtered copy, so the caller's own memo can tell the
// unfiltered case apart by identity.
export function rowsForOperator(rows, chip) {
  if (!chip) return rows || [];
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
