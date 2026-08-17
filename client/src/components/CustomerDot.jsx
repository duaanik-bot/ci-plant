import { customerHue } from '../lib/customerColour.js';
import { customerInitials } from '../lib/customerCode.js';

// The customer's identity colour, riding just ahead of the initials it belongs
// to. The SAME dot appears in the filter chip and on every row, so the rail and
// the queue speak one language — and, more to the point, so an UNFILTERED queue
// is scannable. That is where this earns its keep: the queue runs 112 lines of
// Swiss Garnier Life Sciences against 26 of Swiss Garniers Biotech, which as
// text are nearly the same string and as SGLS/SGB are two letters apart.
//
// Lived inside Planning.jsx until Artwork, Job Cards and Print Planning grew the
// same chips. Four pages cannot import from a page, and the colour is only worth
// anything if it is the SAME colour everywhere — a customer that is lime on the
// planning queue and pink on the job card register teaches the planner nothing.
// So the dot moved here and Planning imports it back; nothing about it changed.
//
// Decorative only — the initials beside it already carry the name, and the full
// name is on the cell's title — so it is aria-hidden and never the sole carrier
// of the fact. customerHue returns null for a row with no customer, and this
// then renders NOTHING rather than a dot in some arbitrary colour: an absent
// customer must not look like a customer whose colour you have not learnt yet.
export function CustomerDot({ id, className = '' }) {
  const hue = customerHue(id);
  if (!hue) return null;
  return <span aria-hidden
    className={`mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${hue.dot} ${className}`} />;
}

// Dot + initials, the pairing every row wants. The full name goes on `title`,
// which is the one place it is readable in full — the initials are an
// abbreviation and the dot is decoration, so neither can be the only carrier.
export function CustomerTag({ id, name, className = '' }) {
  return (
    <span title={name || undefined} className={`whitespace-nowrap ${className}`}>
      <CustomerDot id={id} />{customerInitials(name) || name || '—'}
    </span>
  );
}
