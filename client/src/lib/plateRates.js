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
// It happened to come out right, which is worse than being wrong: over the wire
// effective_from arrives as IST-midnight-in-UTC ("2026-08-07T18:30:00.000Z"), a
// day early, and the toISOString() on the other side was a day early too, so the
// two errors cancelled. Normalise ONE of them — which is exactly what fixing the
// server invites — and the cancellation goes with it, leaving a blank rate and a
// Rs 0 total in front of a buyer about to click Create PO. So neither side leans
// on the other's error any more.

// A calendar day as 'YYYY-MM-DD'. LOCAL parts, never toISOString().
function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  // A wire value is an ISO instant, not a local day: take the instant back to a
  // Date so the local-parts rule above applies to it too. A bare 'YYYY-MM-DD'
  // has no instant to shift and is already the answer.
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : dayOf(parsed);
}

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
