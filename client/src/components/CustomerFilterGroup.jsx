import { FilterChip, FilterGroup } from './FilterChip.jsx';
import { customerHue } from '../lib/customerColour.js';
import { customerInitials } from '../lib/customerCode.js';
import { showCustomerChips } from '../lib/customerChips.js';

// The CUSTOMER axis of a filter rail — one group, four pages: Planning, Artwork,
// Job Cards and Print Planning.
//
// It answers "whose work is this", which is a different question from every
// other chip on these rails: those describe how a job PRINTS (board, set type,
// ink, urgency), this describes who it is FOR. Hence its own caption, per the
// FilterChip rule that structure carries identity.
//
// ── THE PILL STAYS NEUTRAL AND THE COLOUR LIVES IN THE DOT ──────────────────
// Not a style choice. On these pages colour is load-bearing and already spoken
// for: violet means gang, teal combined, amber hold, emerald board covered, red
// short, blue a lit control. A chip tinted in a company's colour would be read
// as a STATUS — it would look like it was warning about something. A dot is
// small enough to identify a company without asserting anything about it, so the
// pill lights graphite exactly the way the set-type chips light and the hue
// appears only in the 8px circle. (customerColour.js picks those eight hues by
// CIELAB measurement to clear all six reserved ones; do not add a ninth by eye.)
//
// Renders NOTHING below two customers: a filter offering one choice narrows
// nothing, and a rail should not grow to say so. The group's hairline goes with
// it, so a single-customer board looks exactly as it did before this shipped.
export function CustomerFilterGroup({
  chips, selected = [], onToggle, scope = 'here', unit = 'row', divider = true, note,
}) {
  if (!showCustomerChips(chips)) return null;
  return (
    <FilterGroup label="Customer" divider={divider}>
      {chips.map(c => {
        const hue = customerHue(c.id);
        const n = `${c.count} ${unit}${c.count === 1 ? '' : 's'}`;
        return (
          <FilterChip key={c.id} label={customerInitials(c.name) || '—'} count={c.count}
            dot={hue?.dot} on={selected.includes(c.id)}
            title={`${c.name?.trim() || 'Unnamed customer'} — ${n} ${scope}.`
              + ` ${note || 'Composes with the other filters and the search'};`
              + ' click again to clear.'}
            onClick={() => onToggle(c.id)} />
        );
      })}
    </FilterGroup>
  );
}
