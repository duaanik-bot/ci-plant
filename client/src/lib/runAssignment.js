// Which machine and which operator a job starts on.
//
// At Cutting and Printing the plant has already decided both: printing gets its
// press from the Print Planning board, and cutting runs on one flagged default
// machine crewed by one man. So the Start modal arrives filled and the operator
// only ticks line clearance. Every other station picks by hand — and picks from
// a blank, so no machine is ever recorded by silence.
//
// Pure functions, no React. Covered by server/src/run-assignment.test.js.

// The only stations that prefill. Widening this list is a plant decision, not a
// code cleanup: a station qualifies when its machines each have ONE dedicated
// operator, which is what makes the operator unambiguous.
export const AUTO_ASSIGN_SECTIONS = ['cutting', 'printing'];

export const autoAssigns = section => AUTO_ASSIGN_SECTIONS.includes(section);

// The machine this run should start on, or null when nothing can be resolved.
// Only a machine present in `machines` can win — that list is this station's
// active machines, already narrowed by the user's press scope — so a retired or
// out-of-scope machine falls through to the next rule instead of being posted.
export function resolveMachine(section, row, machines) {
  if (!autoAssigns(section)) return null;
  const list = machines || [];
  const pick = id => (id == null ? null : list.find(m => String(m.id) === String(id)) || null);
  return pick(row?.machine_id)                                              // already on the stage
    || (section === 'printing' ? pick(row?.press_machine_id) : null)        // the planned press
    || list.find(m => Number(m.is_default) === 1)                           // the station's default
    || (list.length === 1 ? list[0] : null)                                 // the only machine there is
    || null;
}

// The operator for a resolved machine. One active assigned person means there is
// nothing to choose. Anything else stays blank, and the server falls back to the
// planned operator or the signed-in user exactly as it does today.
//
// The `crew.some` guard matters: a pending row's `operator` comes from a
// COALESCE that falls back to the JOB CARD's press, so a cutting row reports the
// PRESS operator. Only a name actually on this machine is accepted.
export function resolveOperator(machine, row) {
  const crew = machine?.operators || [];
  if (crew.length === 1) return crew[0].name;
  const planned = row?.operator;
  return planned && crew.some(o => o.name === planned) ? planned : '';
}

// What the Start modal opens with. `auto` is true only when a machine was
// actually resolved — that is what earns the AUTO chip and hides the pickers.
export function resolveAssignment(section, row, machines) {
  const machine = resolveMachine(section, row, machines);
  return {
    machine,
    machineId: machine ? String(machine.id) : '',
    operator: machine ? resolveOperator(machine, row) : '',
    auto: !!machine,
  };
}
