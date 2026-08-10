// What this board master needs from a person — the RM screen's own verdict.
//
// DELIBERATELY NOT BoardStatus.jsx. That module answers "can this job run
// today?" for a JOB. This answers "does this BOARD need someone to do
// something?" One word carrying two meanings across two screens is the exact
// failure BoardStatus.jsx was extracted to prevent, so this shares its SHAPE
// and none of its STRINGS.
//
// A FIRST-MATCH LADDER, not four exclusive states. They nest: a board with no
// free stock is also below any buy line worth setting. The order IS the
// semantics — it answers "what would a person do about this board first?"
//
//   RECOUNT    the book and the shelf disagree. Nothing else can be trusted
//              until someone counts, so it outranks everything.
//   FROZEN OUT every sheet is spoken for. Not a fault — the plant is working —
//              but nothing here can be promised. Requires Frozen > 0, so an
//              EMPTY board is never called frozen out.
//   BELOW LINE free stock is under the buy line. A buying decision, not a
//              floor one. Only when a buy line is actually set.
//   OK
export const HEALTH = {
  recount:   { label: 'RECOUNT',    tone: 'text-amber-600',   hint: 'The book and the shelf disagree — count this board' },
  frozen_out:{ label: 'FROZEN OUT', tone: 'text-slate-500',   hint: 'Every sheet is frozen for a job — nothing free to promise' },
  below_line:{ label: 'BELOW LINE', tone: 'text-red-600',     hint: 'Free stock is under the buy line' },
  ok:        { label: 'OK',         tone: 'text-emerald-600', hint: 'Free stock is above the buy line' },
};

export function healthOf({ openWriteOn = 0, frozen = 0, free = 0, buyLine = 0 } = {}) {
  if (+openWriteOn > 0) return 'recount';
  if (+free <= 0 && +frozen > 0) return 'frozen_out';
  if (+buyLine > 0 && +free < +buyLine) return 'below_line';
  return 'ok';
}

export function HealthBadge({ state }) {
  const h = HEALTH[state] || HEALTH.ok;
  return <span className={`text-xs font-semibold ${h.tone}`} title={h.hint}>{h.label}</span>;
}
