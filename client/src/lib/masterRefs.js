// Masters: the heavy picker refs, loaded by the tab whose form picks from them.
//
// The Masters mount effect used to fetch the whole product master (1,847 KB)
// and the die list (~250 KB) on EVERY tab — Customers, Machines, Employees,
// Boards — and on the Products tab it fetched /products a second time beside
// the tab's own load. Only one form reads each:
//   • products — the Blocks form's "Linked Product" ref field
//   • dies     — the Products form's "Die (Tooling Hub)" ref field (tool_id)
// The Blocks picker keeps the FULL master, not /products/picker: its options
// carry data-search={searchText(row)}, which walks every field of the record.
//
// A pure module so masters-lazy-refs.test.js can pin it (a .jsx cannot be
// imported by node --test).
export const TAB_REFS = Object.freeze({
  blocks: Object.freeze([{ ref: 'products', endpoint: '/products' }]),
  products: Object.freeze([{ ref: 'dies', endpoint: '/tools?family=die' }]),
});

// The refs a tab still needs. `requested` holds the refs already fetched (or in
// flight) this visit to Masters, so hopping Blocks → Customers → Blocks does not
// pull the master again.
export function refsToLoad(tab, requested) {
  return (TAB_REFS[tab] || []).filter(x => !requested.has(x.ref));
}
