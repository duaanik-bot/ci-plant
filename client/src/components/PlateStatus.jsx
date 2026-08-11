// Plate status — ONE vocabulary for the whole ERP, twin of BoardStatus.jsx.
//
// The server decides the state (helpers.js `plateStateOf`, gangs already collapsed
// to their weakest member); this file decides how it LOOKS, so Planning, Artwork,
// Job Cards, Print Planning and the press and cutting queues cannot describe one
// fact five different ways. A page that re-declares its own labels or tones is the
// bug this module exists to prevent.
//
// The words name what the reader has to DO about the plates, which is the only
// reason the state is on screen: nothing, chase the delivery, or raise a PR.
import { CheckCircle2, Truck, AlertTriangle } from 'lucide-react';

// 'PR Not Raised', not 'No Plates': the plant thinks about this state as a
// piece of work nobody has started, not as an absence. It also makes the state
// and the action the same words, which is what a filter chip needs to say.
export const PLATE_LABEL = { ready: 'Plates OK', on_order: 'PR Raised', none: 'PR Not Raised' };

// Worst first, so a column sorted on plates puts the jobs needing action on top
// — the same ordering rule BOARD_RANK gives the board column.
export const PLATE_RANK = { none: 0, on_order: 1, ready: 2 };
export const PLATE_FULL = {
  ready: 'Plates OK — in hand',
  on_order: 'PR Raised — plates still to arrive',
  none: 'PR Not Raised — nothing raised yet',
};
export const PLATE_HINT = {
  ready: 'every plate for this job is on the rack, reserved or already on the press',
  on_order: 'the plates are bought and still to be received',
  none: 'plates are neither in hand nor on order — somebody has to raise them',
};
// Both troubled states are RED, for the same reason the board's are: both mean this
// job cannot print today, and amber would let "PR Raised" read as a third, milder
// kind of fine. DEPTH separates them — a soft tint for plates bought and coming
// (someone has acted; wait), a solid fill for plates nobody has raised (act).
// `ready` is a SOLID fill, not a tint. It was a pale wash the same weight as
// every other chip on the row, and on a queue of thirty jobs the one fact the
// press actually needs — are the plates here — did not survive the scan. The
// two troubled states were already solid or near it, so the good state has to
// carry the same weight or the row reads as "nothing to see" whichever it is.
export const PLATE_TONE = {
  ready: 'border-emerald-600 bg-emerald-600 text-white',
  on_order: 'border-red-200 bg-red-50 text-red-600',
  none: 'border-red-500 bg-red-500 text-white',
};
const PLATE_ICON = { ready: CheckCircle2, on_order: Truck, none: AlertTriangle };

// The short circular form for a dense row or a card face, where the whole sentence
// would change the row height. Icon plus two letters, never a wrapping word — the
// full state is in the `title`, which is where a reader who needs it will look.
export const PLATE_SHORT = { ready: 'OK', on_order: 'PR', none: '—' };

// `compact` is the circle: fixed size, so dropping it into a card or a table cell
// cannot grow the row. Without it you get the labelled pill.
export default function PlateStatus({ state, compact = false, className = '' }) {
  const key = PLATE_TONE[state] ? state : 'none';
  const Icon = PLATE_ICON[key];
  const title = PLATE_FULL[key] + ' — ' + PLATE_HINT[key];
  // Sized up from h-6/12px and text-[11px]. On a dense queue the plate chip sat
  // at the same weight as the row's quiet metadata and was read as decoration;
  // it is the one thing that decides whether the job can go on the press today.
  // Still a FIXED size, so dropping it into a card or a cell cannot grow the row.
  if (compact) {
    return (
      <span title={title} aria-label={PLATE_FULL[key]}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold leading-none ${PLATE_TONE[key]} ${className}`}>
        <Icon size={15} />
      </span>
    );
  }
  return (
    <span title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-bold ${PLATE_TONE[key]} ${className}`}>
      <Icon size={14} /> {PLATE_LABEL[key]}
    </span>
  );
}
