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

export const PLATE_LABEL = { ready: 'Plates OK', on_order: 'PR Raised', none: 'No Plates' };
export const PLATE_FULL = {
  ready: 'Plates OK — in hand',
  on_order: 'PR Raised — plates still to arrive',
  none: 'No Plates — nothing raised',
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
export const PLATE_TONE = {
  ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
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
  if (compact) {
    return (
      <span title={title} aria-label={PLATE_FULL[key]}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none ${PLATE_TONE[key]} ${className}`}>
        <Icon size={12} />
      </span>
    );
  }
  return (
    <span title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-bold ${PLATE_TONE[key]} ${className}`}>
      <Icon size={12} /> {PLATE_LABEL[key]}
    </span>
  );
}
