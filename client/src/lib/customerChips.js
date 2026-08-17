import { customerInitials } from './customerCode.js';

// The customer filter-chip RULES, in one place, for the four pages that wear
// them: Planning, Artwork, Job Cards and Print Planning.
//
// Planning shipped these first and the other three were asked for afterwards.
// Copying its ~20 lines into three more pages would have put four copies of two
// rules that are easy to get subtly wrong in four files — and one of them, the
// release guard, fails in a way nobody reports as a bug. So the logic lives here
// as plain functions and the pages only decide what a "row" is.
//
// A .js file, not .jsx, so `node --test` can run it — the same reason
// lib/packets.js and lib/boardCode.js are here rather than beside their pages.
// The chips' MARKUP is CustomerFilterGroup.jsx; this file is the arithmetic.
//
// ── THE TWO RULES ────────────────────────────────────────────────────────────
//
// 1. A CHIP COUNTS WHAT IT WOULD KEEP, never what the other chips left. So the
//    count is taken on the rows the page is already showing BEFORE the customer
//    filter narrows anything. Count them after and every chip reads its own
//    count when lit and 0 when not, which tells the planner nothing.
//
// 2. A SELECTION THAT RUNS OUT OF ROWS RELEASES. Chips are hidden below two
//    customers and a chip disappears when its last row leaves the tab, so a
//    selection can outlive its own control — and then the planner is on an empty
//    table with nothing visible to clear. Filtering on ids that no longer have a
//    chip is therefore a no-op, not an empty result.

// Every customer a row speaks for. A gang is ONE row standing for several
// cartons which can belong to different companies, so it answers to each of
// their chips; a plain row is its own single member.
const membersOfRow = (row, membersOf) => {
  const ms = membersOf ? membersOf(row) : null;
  return Array.isArray(ms) && ms.length ? ms : [row];
};

// The customers present in `rows`, busiest first.
//
// A run counts ONCE per customer however many of its members that customer
// owns — the chip counts ROWS, because rows are what the table shows and what
// the planner is about to look at.
//
// Ties break on the initials rather than on the id so the rail's order is stable
// and readable: on a board where six customers all have one job, ordering by id
// would look arbitrary and change as ids are handed out.
export function customerChipsFrom(rows, membersOf) {
  const seen = new Map();
  for (const row of rows || []) {
    for (const m of membersOfRow(row, membersOf)) {
      const id = m?.customer_id;
      if (id == null) continue;
      if (!seen.has(id)) seen.set(id, { id, name: m.customer_name, rows: new Set() });
      seen.get(id).rows.add(row);
    }
  }
  return [...seen.values()]
    .map(c => ({ id: c.id, name: c.name, count: c.rows.size }))
    .sort((a, b) => b.count - a.count
      || customerInitials(a.name).localeCompare(customerInitials(b.name)));
}

// `rows` narrowed to the selected customers — with rule 2 applied.
//
// `chips` is what customerChipsFrom returned for the SAME rows, and it is what
// decides whether a selected id still exists. Passing the chips in rather than
// recomputing them here is deliberate: the page has already built them for the
// rail, and the guard has to test against exactly the set the planner can see.
export function filterByCustomers(rows, selected, chips, membersOf) {
  const live = (selected || []).filter(id => (chips || []).some(c => c.id === id));
  if (!live.length) return rows;                      // nothing selected, or nothing left to select
  const keep = new Set(live);
  return (rows || []).filter(row =>
    membersOfRow(row, membersOf).some(m => keep.has(m?.customer_id)));
}

// A rail offering ONE choice narrows nothing, and the strip should not grow to
// say so. Stated here rather than as `> 1` in four pages so the four cannot
// drift — and so the reason survives next to the number.
export const showCustomerChips = chips => (chips?.length || 0) > 1;

// Clicking a chip. Multi-select because "SGLS and SGB, nothing else" is a real
// question the planner asks and a single pick cannot answer; clicking a lit chip
// again clears just that one. Returns a NEW array — it is fed straight to a
// useState setter, which ignores a mutated one.
export const toggleCustomer = (selected, id) =>
  ((selected || []).includes(id)
    ? selected.filter(x => x !== id)
    : [...(selected || []), id]);
