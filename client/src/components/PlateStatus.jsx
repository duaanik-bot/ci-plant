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

// ── Wear: is this job about to print off plates that have run before ─────────
//
// A SECOND axis, never a fourth state. "Plates OK" answers can it print; this
// answers what it is printing WITH, and the two are independent — a job can hold
// every plate it needs and every one of them be worn. Folding wear into
// PLATE_TONE would have made a used-but-complete set look like a shortage.
//
// The plant's own words, taken from MANUAL_PLATE_RACKS (server/src/plates.js):
// Fresh is a plate that has never printed, Used has already run. Not "new/old" —
// the rack is filed under these two, and a screen that renamed them would be a
// third vocabulary for a fact the warehouse already has two.
export const WEAR_LABEL = { fresh: 'Fresh', used: 'Used' };
export const WEAR_TONE = {
  fresh: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  // The same light pink-red the register tints a used row with, so the badge on a
  // Planning card and the row on the Plates screen are recognisably one fact.
  used: 'border-red-200 bg-red-50 text-red-700',
};
export const WEAR_FULL = {
  fresh: 'Fresh — these plates have never printed',
  used: 'Used — at least one of these plates has already run',
};

// Fresh/Used, and the louder thing that outranks both: a plate somebody has
// physically marked Fair, Damaged, Scrapped or Lost. Replacement is a CONDITION
// verdict and never a run count — the plant sets no plate-life limit, so a high
// number here is a fact to read, not a plate to pull.
export function PlateWear({ wear, runs = null, replace = 0, compact = false, className = '' }) {
  if (replace > 0) {
    return (
      <span title={`${replace} plate${replace === 1 ? '' : 's'} on this job need replacing — condition is not Good`}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-600 bg-red-600 px-1.5 py-0.5 text-[10px] font-extrabold text-white ${className}`}>
        <AlertTriangle size={10} /> {compact ? replace : `Replace ${replace}`}
      </span>
    );
  }
  if (!WEAR_LABEL[wear]) return null;
  const count = Number(runs) || 0;
  return (
    <span title={WEAR_FULL[wear] + (wear === 'used' && count ? ` · ${count} run${count === 1 ? '' : 's'}` : '')}
      className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-extrabold ${WEAR_TONE[wear]} ${className}`}>
      {/* The smile is the whole word at this size — a brand-new plate is the one
          state on this badge that is unambiguously good news. */}
      {wear === 'fresh' ? <>🙂{compact ? '' : ' Fresh'}</> : <>{compact ? '' : 'Used '}×{count}</>}
    </span>
  );
}

// `compact` is the circle: fixed size, so dropping it into a card or a table cell
// cannot grow the row. Without it you get the labelled pill.
// `counts` is {have, need} from the server (helpers.plateCountsOf) — how many
// plates are physically on the rack out of how many the job owes.
//
// It QUALIFIES the state and never softens it. One plate missing of four and
// four missing of four are the same colour on purpose, because a press cannot
// run on either; what differs is how close the chase is, and that is the only
// thing the fraction adds. Shown only while the job is short — on a green badge
// "4/4" is noise, the tick already said it.
// `wear`/`wearRuns`/`wearReplace` come from the server on the same row the state
// does (helpers.stampPlateState). They render as a SEPARATE mark beside the badge
// rather than changing its colour, because they answer a different question and a
// reader must be able to see a green "Plates OK" and a pink "Used" at once.
export default function PlateStatus({
  state, counts = null, compact = false, className = '',
  wear = null, wearRuns = null, wearReplace = 0,
}) {
  const key = PLATE_TONE[state] ? state : 'none';
  const Icon = PLATE_ICON[key];
  const partial = counts && counts.need > 0 && counts.have > 0 && counts.have < counts.need;
  const short = counts && counts.need > 0 && key !== 'ready';
  const title = PLATE_FULL[key] + ' — ' + PLATE_HINT[key]
    + (short ? ` · ${counts.have} of ${counts.need} plate${counts.need === 1 ? '' : 's'} on the rack` : '');
  const mark = (wear || wearReplace > 0)
    ? <PlateWear wear={wear} runs={wearRuns} replace={wearReplace} compact={compact} />
    : null;
  // Sized up from h-6/12px and text-[11px]. On a dense queue the plate chip sat
  // at the same weight as the row's quiet metadata and was read as decoration;
  // it is the one thing that decides whether the job can go on the press today.
  // Still a FIXED size, so dropping it into a card or a cell cannot grow the row.
  if (compact) {
    // The circle is a FIXED size and must stay one; the wear mark sits beside it
    // in a shrink-0 pair so a dense queue row still cannot grow.
    const circle = (
      <span title={title} aria-label={PLATE_FULL[key]}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold leading-none ${PLATE_TONE[key]} ${mark ? '' : className}`}>
        {/* The circle has no room for a word, so a partial job shows the
            fraction alone — that IS the information at this size. */}
        {partial ? <span className="text-[9px] font-extrabold tabular-nums">{counts.have}/{counts.need}</span> : <Icon size={15} />}
      </span>
    );
    if (!mark) return circle;
    return <span className={`inline-flex shrink-0 items-center gap-1 ${className}`}>{circle}{mark}</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span title={title}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-bold ${PLATE_TONE[key]}`}>
        <Icon size={14} /> {PLATE_LABEL[key]}
        {short && <span className="rounded-full bg-white/25 px-1.5 text-[10px] font-extrabold tabular-nums">{counts.have}/{counts.need}</span>}
      </span>
      {mark}
    </span>
  );
}
