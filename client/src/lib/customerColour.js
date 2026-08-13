// Customer identity colour — the dot that lets a planner tell one company's
// rows from another's without reading the text.
//
// The queue runs 112 lines of "Swiss Garnier Life Sciences" against 26 of
// "Swiss Garniers Biotech Private Limited". As text those two are nearly the
// same string; as SGLS and SGB they are two letters apart. A colour is what
// makes them separable at a glance, which is the whole reason this file exists.
//
// KEYED ON customer_id, NEVER THE NAME. One customer is stored as
// "Fluence Pharamceuticals Pvt. Ltd. " — misspelled, trailing space. The day
// someone corrects that spelling a name-keyed colour would silently reassign
// itself and the planner's learned mapping would break. An id survives a
// rename, so the id is the key.
//
// This is a DISPLAY colour only. Nothing is stored, sent or matched on it.

// The six hues that already MEAN something across this ERP. A customer dot
// wearing one of these would be read as a status, so the palette below draws
// from none of them:
//   violet  — gang (splits after die cutting)
//   teal    — combined run (one product, one pile)
//   amber   — hold
//   emerald — board covered
//   red     — board short
//   blue    — lit control / Customer WIP
export const RESERVED_HUES = ['blue', 'emerald', 'violet', 'teal', 'amber', 'red'];

// Eight hues, ordered so that ADJACENT SLOTS CONTRAST. Customers created in one
// sitting are handed consecutive ids, so id-neighbours are exactly the pairs
// most likely to sit in the queue together — the palette must not put two
// shades of one colour next to each other. That rule is what separates the
// plant's three biggest customers, who hold ids 4, 5 and 6.
//
// Both the MEMBERS and their ORDER were chosen by measurement, not taste, and
// customer-colour.test.js re-measures them: every hue here is at least ΔE 25
// from all six status colours AND from every other hue, resolved through THIS
// project's tailwind.config.js rather than stock Tailwind. That last part
// matters — the config aliases `indigo` to systemBlue, so an indigo dot would
// have been the "lit control" blue exactly, which is the kind of thing a
// name-only check cannot see.
//
// Written as whole literal class strings on purpose: Tailwind's scanner only
// sees classes that appear verbatim in the source, so `bg-${hue}-500` would
// compile to nothing.
export const CUSTOMER_HUES = [
  { name: 'slate-700',  dot: 'bg-slate-700' },
  { name: 'yellow-700', dot: 'bg-yellow-700' },
  { name: 'sky-500',    dot: 'bg-sky-500' },
  { name: 'green-700',  dot: 'bg-green-700' },
  { name: 'pink-500',   dot: 'bg-pink-500' },
  { name: 'lime-500',   dot: 'bg-lime-500' },
  { name: 'stone-500',  dot: 'bg-stone-500' },
  { name: 'rose-500',   dot: 'bg-rose-500' },
];

// The hue for one customer, or null where there is no customer — the caller
// renders its own dash rather than a dot in some arbitrary colour.
//
// Plain modulo rather than a hash: the ids in play are small and clustered, and
// modulo spreads a run of consecutive ids perfectly across the palette where a
// hash would scatter them and could collide.
export function customerHue(customerId) {
  if (customerId == null || customerId === '') return null;
  const id = Number(customerId);
  if (!Number.isFinite(id)) return null;
  return CUSTOMER_HUES[Math.abs(Math.trunc(id)) % CUSTOMER_HUES.length];
}
