// Browser twin of resolvePlateRate in server/src/plates.js. The client cannot
// import server code, so this is duplicated deliberately — and held to the
// server's answers by a parity test (server/src/plate-rate-parity.test.js), which
// is the only thing that stops a twin drifting into a different price.
//
// Both sides must read a day the SAME way. The server's copy was reading a pg
// `date` as "Sat Aug 08" (String(aDate) begins with the weekday) and refusing
// every Plate PO. This copy had the other half of the family: onDate.toISOString()
// is the PREVIOUS day east of Greenwich, so between midnight and 05:30 IST — the
// night shift — "today" read as yesterday.
//
// The two errors did NOT cancel on this route, and it matters which way round it
// was. GET /plate-rates selects `to_char(pr.effective_from,'YYYY-MM-DD') AS
// effective_from` after `pr.*`, and node-postgres assigns row keys in column
// order, so the alias overwrites the raw date: the browser receives a bare
// "2026-08-11", already correct. Only the onDate side was a day behind. So
// between midnight and 05:30 IST a rate effective TODAY was simply dropped —
// and when an older base rate was still standing, the modal resolved THAT,
// pre-filled it, and POSTed it. plates.js does `requestedRate ?? masterRate`,
// so a supplied rate wins outright: the stale price is what got written to the
// PO line. This twin is not a preview.
//
// dayOf itself now lives in ./dayOf.js — one spelling per side, imported here.
import { dayOf } from './dayOf.js';

export function resolvePlateRate(rates = [], plateMasterId, vendorId = null, onDate = new Date()) {
  const masterId = Number(plateMasterId);
  const wantedVendor = vendorId == null || vendorId === '' ? null : Number(vendorId);
  const date = dayOf(onDate);
  const candidates = rates.filter(row => Number(row.plate_master_id) === masterId
    && Number(row.active) === 1
    && (!row.effective_from || dayOf(row.effective_from) <= date)
    && (row.vendor_id == null || Number(row.vendor_id) === wantedVendor));
  candidates.sort((a, b) => {
    const aSpecific = a.vendor_id != null && Number(a.vendor_id) === wantedVendor ? 1 : 0;
    const bSpecific = b.vendor_id != null && Number(b.vendor_id) === wantedVendor ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    const byDate = String(dayOf(b.effective_from) || '').localeCompare(String(dayOf(a.effective_from) || ''));
    return byDate || Number(b.id) - Number(a.id);
  });
  return candidates[0] || null;
}
