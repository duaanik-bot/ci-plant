// One copy of a numbered save on the wire at a time.
//
// No save button in the app shows a busy state, so a double-click sends the
// same POST twice. The server used to turn some of those into a 500 by accident:
// both copies read the same highest document number and the second INSERT hit
// the unique index — that was the production `grns_grn_number_key (CI-GRN-0105)`
// error of 2026-09-17, one user, the same second as the GRN it collided with.
// The document-number lock (server helpers.js lockDocNumber) ends that race, and
// with it the accident: the second copy now waits, mints the next number and
// saves a SECOND GRN / PO / receipt. Double submits that did not overlap closely
// enough to collide were already saved twice (the over-received PO lines of
// 2026-08-11, one booked 13 ms after its twin).
//
// So api.js joins them here: while a POST to a route that MINTS a document
// number is in flight, the same URL, body and sign-in again gets the first
// call's promise — its answer, or its refusal — instead of a second request.
// Once that settles, the next identical POST goes out as normal: a retry after
// an error, or a real second receipt entered afresh. Anything that differs
// between two saves (a quantity, a line, a note) makes the bodies differ, and
// those are never joined.
//
// Only minting routes, never every write: plenty of writes mean it when they
// repeat inside one round trip — the Live Floor queue arrow (each tap is one
// place), the Status Sheet's optimistic P1 / WIP / EDD edits (on-off-on would
// be joined to the first "on" and leave the server "off"), the station's
// additive day count, a chat "ok" sent twice. A minting POST repeated inside a
// round trip is always the same click twice. mint-routes-join-once.test.js
// scans the server for every route that mints and holds this list to it.
//
// Pure — no fetch, no React — so the server suite can pin it.

// Express paths of every POST that mints a document number (CI-GRN-, CI-VPO-,
// CI-RCPT-, CI-CH-, CI-FG-/CI-BOX-, CI-JC-, CI-PR-, DIE-/PLT-/BLK-, a product's
// SW-769 Internal Code, …).
export const MINTING_POSTS = Object.freeze([
  '/approvals',
  '/board/move',
  '/coas',
  '/dispatches',
  '/extra-sheets',
  '/fg-lots',
  '/fg-lots/manual',
  '/fg/move',
  '/fg/move-bulk',
  '/gang-runs',
  '/gang-runs/:id/convert-to-merge',
  '/gang-runs/:id/raise-pr',
  '/gang-templates/:id/create-run',
  '/grns',
  '/grns/bulk',
  '/grns/direct',
  '/grns/substitute',
  '/invoices',
  '/invoices/:id/lines/:lineId/remove',
  '/job-cards/:id/tooling-requirements',
  '/job-stages/:id/complete',
  '/merge-runs',
  '/order-lines/:id/job-card',
  '/order-lines/:id/raise-pr',
  '/order-lines/:id/shortage',
  '/orders/import/quick-product',
  '/payments',
  '/plate-masters',
  '/plates/grns',
  '/plates/grns/bulk',
  '/plates/purchase-orders',
  '/plates/warehouse/assets',
  '/products',
  '/products/:id/migrate-customer',
  '/purchase-orders',
  '/purchase-orders/from-requisitions',
  '/requisitions',
  '/requisitions/:id/convert',
  '/shade-cards',
  '/shade-cards/legacy/promote',
  '/tooling/procurement/:family/grns',
  '/tooling/procurement/:family/inventory',
  '/tooling/procurement/:family/purchase-orders',
  '/tooling/requirements/:id/actions',
  '/tools',
  '/tools/push',
  '/workflow/order-lines/:id',
]);

const toRegex = route => new RegExp(`^${route.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
const MINTING = MINTING_POSTS.map(toRegex);

// Does a POST to this URL (query string ignored) mint a document number?
export function mintsNumber(url) {
  const pathOnly = String(url).split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return MINTING.some(re => re.test(pathOnly));
}

// null = never join: every read, every write that is not a minting POST, and a
// body that cannot be serialised (sending it would fail anyway, on its own).
export function writeKey(method, url, body, token) {
  if (method !== 'POST' || !mintsNumber(url)) return null;
  let payload;
  try { payload = body === undefined ? '' : JSON.stringify(body); } catch { return null; }
  if (payload === undefined) return null;
  return `${method} ${url}\n${token || ''}\n${payload}`;
}

// A double-click lands within a second, but the FIRST save can legitimately run
// for as long as the server lets it — vercel.json maxDuration, 30 s — and a
// second press while it still may commit would book the duplicate. Past that
// (plus the network's margin) the first has answered or died, so a press still
// waiting on a hung connection (plant Wi-Fi dropped) goes out as before.
export const JOIN_WINDOW_MS = 35_000;

// Runs `start` unless an identical write went on the wire within the window and
// is still there, in which case the caller shares that one. The slot clears
// when the write settles either way.
export function joinIdentical(inFlight, key, start, now = Date.now()) {
  if (key == null) return start();
  const same = inFlight.get(key);
  if (same && now - same.at < JOIN_WINDOW_MS) return same.p;
  const p = start();
  const slot = { p, at: now };
  inFlight.set(key, slot);
  const clear = () => { if (inFlight.get(key) === slot) inFlight.delete(key); };
  p.then(clear, clear);
  return p;
}
