import { Zap } from 'lucide-react';
import { FilterChip, FilterGroup } from './FilterChip.jsx';

// The URGENCY axis — "only the jobs the customer is chasing".
//
// Print Planning had this chip and nowhere else did, which is backwards: the
// planner meets a WIP job on the artwork queue and the job-card register long
// before it reaches the press board, and those are exactly the desks where
// "show me only what is being chased" is the question being asked out loud.
//
// One group, four pages, so the chip a planner learns on one queue is the same
// control on the next — the FilterChip contract applied to this axis the way
// CustomerFilterGroup applies it to the customer.
//
// ── WHY THIS ONE KEEPS THE BLUE ─────────────────────────────────────────────
// Colour is spent only where the plant must act, and this rail's other hues are
// taken: emerald covered, red short, amber hold, violet gang, teal combined.
// Customer WIP takes the system blue instead, and it is the ONLY classification
// chip allowed to, for two reasons:
//
//   1. It matches WipChip in ui.jsx exactly — the badge on the row and the chip
//      that filters to it are the same blue, so the eye connects them without
//      being taught. That is the whole point of having a badge AND a chip.
//   2. Blue means "a control you switched on" across this ERP, and urgency is
//      the customer's, not a fault. Amber and red stay for things that are
//      wrong; a job being chased is not wrong.
//
// Hidden at zero. Every other chip on these rails RECEDES at zero rather than
// hiding, because "Stock Short 0" is worth reading — it is the good news. This
// one is the exception: "Customer WIP 0" is not news, it is the ordinary state
// of a board, and a permanently dark blue chip on four rails is exactly the
// clutter the caption structure exists to avoid. The group's hairline goes with
// it, so a board with nothing being chased looks as it did before this shipped.
export function WipFilterGroup({ count = 0, on, onToggle, scope = 'here', unit = 'job', divider = true }) {
  if (!count && !on) return null;
  const n = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return (
    <FilterGroup label="Urgency" divider={divider}>
      <FilterChip label="Customer WIP" icon={Zap} count={count} on={on}
        tone="border-[#0A84FF]/30 bg-[#0A84FF] text-white" countTone="bg-white/25"
        title={`Only what the customer is chasing — ${n} ${scope}.`
          + ' The same blue as the WIP badge on the rows. Composes with the other'
          + ' filters and the search; click again to clear.'}
        onClick={onToggle} />
    </FilterGroup>
  );
}

// Is this ROW being chased? A run is WIP when ANY member line is: the sheet
// prints together, so one urgent carton makes the whole run urgent — the same
// rule JC_VIEW's `wip` column applies on the server, restated here for the
// pages that group their own gang rows on the client (Planning, Artwork).
export const rowIsWip = row => !!(row?.wip || (row?._gang || []).some(m => m?.wip));
