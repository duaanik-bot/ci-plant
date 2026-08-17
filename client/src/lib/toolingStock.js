// Where a die or block requirement stands against the warehouse.
//
// The register printed FIVE figures for one fact — a chip reading "10 in
// warehouse" and then "Available 10 · Reserved 0 · Free 0" underneath it, so
// Available was said twice and two of the three qualifiers were zero on most
// rows. Worse, the chip's NUMBER was `available` while its COLOUR was keyed on
// `free`: ten plates all reserved for other jobs painted an amber chip reading
// "10 in warehouse", which is the one reading that could stop a buyer ordering.
//
// So the chip says FREE — the number the colour already means, and the number
// that decides whether this requirement has to be bought — and the rest is a
// qualifier only when it is not zero.
//
// Lives in lib/ because `.jsx` cannot be run under `node --test`, and "which
// number goes on the chip" is exactly the kind of rule worth pinning.

const num = value => Number(value) || 0;

export function stockPosition(row) {
  const available = num(row?.stock_available);
  const reserved = num(row?.stock_reserved);
  const free = num(row?.stock_free);
  const ordered = num(row?.stock_ordered);

  // Nothing in the warehouse at all is its own answer — "0 free of 0" is a
  // sum nobody needs to read.
  const headline = available > 0 ? `${free} free of ${available}` : 'None in warehouse';

  const qualifiers = [];
  if (reserved > 0) qualifiers.push({ key: 'reserved', label: `Reserved ${reserved}`, tone: 'amber' });
  if (ordered > 0) qualifiers.push({ key: 'ordered', label: `On order ${ordered}`, tone: 'sky' });

  return {
    available, reserved, free, ordered,
    headline,
    // Free is what the requirement can actually take, so it is what the colour
    // means. Stock that exists but is spoken for is not stock this job has.
    state: free > 0 ? 'free' : available > 0 ? 'spoken_for' : 'none',
    qualifiers,
    // Everything, for the hover — nothing is lost by not printing it.
    title: `Available ${available} · Reserved ${reserved} · Free ${free}${ordered > 0 ? ` · On order ${ordered}` : ''}`,
  };
}
