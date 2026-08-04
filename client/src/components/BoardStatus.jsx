// Board status — ONE vocabulary for the whole ERP.
//
// The server decides the state (helpers.js `boardStateOf`, one partition, gangs
// already collapsed to their weakest member); this file decides how it LOOKS,
// so Print Planning, Planning, Artwork, Job Cards and the cutting queue cannot
// describe one fact five different ways. Every screen that shows the verdict
// imports from here — a page that re-declares its own labels or tones is the
// bug this module exists to prevent.
//
// The words name what the reader has to DO about the board, which is the only
// reason the state is on screen at all: nothing, chase the delivery, or raise a
// PR. Short heads for filter chips (they carry a count and live in tight
// rails), the whole sentence on a badge — "PR Raised" alone does not say
// whether the board has landed, and that is the question being asked.
import { CheckCircle2, Truck, AlertTriangle } from 'lucide-react';

export const BOARD_LABEL = { covered: 'Stock OK', on_order: 'PR Raised', short: 'Stock Short' };
export const BOARD_FULL = {
  covered: 'Stock OK',
  on_order: 'PR Raised — Stock Pending',
  short: 'Stock Short — No PR Raised',
};
export const BOARD_HINT = {
  covered: 'board is here — warehouse stock, an alternate board, or board moved to this job',
  on_order: 'a PR names this job and the board is still to be received',
  short: 'uncovered and nothing on order',
};
// Both troubled states are RED, because both mean the same thing to the floor —
// this job cannot run today — and amber let "PR Raised" read as a third, milder
// kind of fine. The DEPTH is what separates them: a soft tint for board that is
// bought and coming (someone has already acted; wait), a solid fill for board
// nobody has ordered (nobody has acted; act). Covered stays green.
export const BOARD_TONE = {
  covered: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  on_order: 'border-red-200 bg-red-50 text-red-600',
  short: 'border-red-600 bg-red-600 text-white',
};
// The count pill a LIT filter chip carries. A tinted tone keeps its white pill;
// the solid `short` fill would put white on white, so its count knocks out of
// the red instead. Any new solid-fill chip needs the same treatment.
export const BOARD_COUNT_TONE = {
  covered: 'bg-white/70', on_order: 'bg-white/70', short: 'bg-white text-red-700',
};
export const BOARD_ICON = { covered: CheckCircle2, on_order: Truck, short: AlertTriangle };
export const BOARD_RANK = { short: 0, on_order: 1, covered: 2 };   // worst first
// The red wash a QUEUE row wears — Planning and Artwork both scan down their
// left edge, so a job short of board must look identical wherever a planner
// meets it. Painted on the TDs from outside @layer (see .ci-row-alarm in
// index.css); it sits UNDER the readiness light rather than instead of it.
// Each page decides WHICH rows are eligible — Planning exempts To Plan, where
// short is the normal state, not an alarm.
export const BOARD_ROW_CLASS = { covered: '', on_order: 'ci-row-alarm-soft', short: 'ci-row-alarm' };

// The row's verdict. The server already resolved it (and already gave every
// member of a gang the run's weakest verdict), so screens cannot drift apart.
// Falls back to the old pending flag for anything served by an older API
// response mid-deploy.
export const boardStateOf = r => r?.board_state || (r?.board_pending ? 'short' : 'covered');

// A gang runs as ONE sheet, so its weakest member decides for the whole run.
// Used where the CLIENT does the grouping (Artwork, Planning) and the server
// therefore cannot have collapsed it already. An older payload with no
// board_state reads `covered` deliberately — a stale response must not paint
// the whole queue red.
export const worstBoardStateOf = rows => (rows || [])
  .map(m => m.board_state || 'covered')
  .reduce((worst, s) => (BOARD_RANK[s] < BOARD_RANK[worst] ? s : worst), 'covered');

// The verdict said out loud. `covered` SPEAKS — it used to stay silent on the
// theory that the absence of an alarm was the good news, but a blank cannot be
// told apart from a row the server never answered for.
//   band   — the card face: full width, centred, read without leaning in
//   (else) — a pill, for a table cell or a chip rail
// `compact` drops the qualifier for rails too tight for the whole sentence.
export function BoardBadge({ state, band, compact }) {
  const Icon = BOARD_ICON[state];
  if (!Icon) return null;                       // unknown/absent state stays silent
  const text = compact ? BOARD_LABEL[state] : BOARD_FULL[state];
  return band ? (
    <div title={BOARD_HINT[state]}
      className={`mt-1 flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-extrabold uppercase tracking-[0.02em] ${BOARD_TONE[state]}`}>
      <Icon size={13} className="shrink-0" /> {text}
    </div>
  ) : (
    <span title={BOARD_HINT[state]}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold ${BOARD_TONE[state]}`}>
      <Icon size={12} className="shrink-0" /> {text}
    </span>
  );
}
