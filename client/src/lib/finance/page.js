// What the Finance pages share and decide without drawing anything: how a page changes its own query string, and what an empty list says
// once a search may be what emptied it. The Vouchers page and the Reports page both read these, so there is one of each.
//
// Pure ESM, no React, no DOM, no imports: the server tests import this file by relative path and the browser bundles it as written.

// The query string a page moves to: `previous` (a URLSearchParams, or its text) with each update applied. A value sets its key, as text
// (a zero is a value); null, undefined and '' remove the key; every other key is kept, in its place. `previous` is not touched, since
// it is the router's own and a page that changed it in place would change what the router thinks it already holds.
//
//   const change = updates => setParams(previous => finQueryWith(previous, updates), { replace: true });
export function finQueryWith(previous, updates) {
  const next = new URLSearchParams(previous);
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') next.delete(key); else next.set(key, String(value));
  }
  return next;
}

// What an empty list says. When a search has been typed and the list had rows before it, it is the SEARCH that emptied it, and "no vouchers
// were posted in this period" or "you have no drafts" would be false assurance on a screen people use to check that nothing is missed.
// With nothing behind the search the list's own sentence is the true one. `noun` is what the list holds, in the plural.
export function finSearchEmpty({ searching, total, none, noun }) {
  return searching && total > 0 ? `No ${noun} match this search.` : none;
}
