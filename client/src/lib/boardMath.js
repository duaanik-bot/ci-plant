// Board weight + rate maths. Board is bought by weight: the plant sets ONE ₹/kg
// per grade (optionally per vendor) and every board's ₹/sheet derives from its
// own GSM and parent sheet size. Nothing here is stored — change a grade's ₹/kg
// and every board in it reprices instantly, with no backfill.
//
// Client twin of server/src/board-math.js — used for live form previews so the
// UI can show a board's weight/rate as the user types, before it hits the
// server. board-math.test.js asserts the two twins produce identical output —
// keep them in sync.
//
// Every function returns null (never 0) when an input is missing, so the UI can
// show "—" for an incomplete master instead of a confident, wrong zero.

const IN_TO_M = 0.0254;

// gsm × area in m² / 1000 → kg for one parent sheet.
export function kgPerSheet(b) {
  const gsm = +b?.gsm, l = +b?.sheet_l, w = +b?.sheet_w;
  if (!(gsm > 0) || !(l > 0) || !(w > 0)) return null;
  return gsm * (l * IN_TO_M) * (w * IN_TO_M) / 1000;
}

export function packetWeight(b) {
  const k = kgPerSheet(b), n = +b?.sheets_per_packet;
  if (k == null || !(n > 0)) return null;
  return k * n;
}

export function ratePerSheet(b, ratePerKg) {
  const k = kgPerSheet(b), r = +ratePerKg;
  if (k == null || !(r > 0)) return null;
  return k * r;
}

export function packetRate(b, ratePerKg) {
  const p = packetWeight(b), r = +ratePerKg;
  if (p == null || !(r > 0)) return null;
  return p * r;
}

// The inverse of ratePerSheet — recover the ₹/kg a stored ₹/sheet was priced at.
// A PO line transacts in sheets, so ₹/sheet is what the line stores; but ₹/kg is
// the number the plant negotiates and the number that belongs on paper. Inverting
// it here means every PO ever raised can state its ₹/kg with no stored column and
// no backfill — and the round trip is exact, since ₹/sheet was kg/sheet × ₹/kg.
export function ratePerKgFromSheet(b, sheetRate) {
  const k = kgPerSheet(b), r = +sheetRate;
  if (k == null || !(r > 0)) return null;
  return r / k;
}

export function totalWeight(b, sheets) {
  const k = kgPerSheet(b), n = +sheets;
  if (k == null || !Number.isFinite(n)) return null;
  return k * n;
}

// Display-only: a PO still transacts in sheets, so fractional packets are kept
// rather than rounded to whole packs.
export function packets(b, sheets) {
  const n = +b?.sheets_per_packet, s = +sheets;
  if (!(n > 0) || !Number.isFinite(s)) return null;
  return s / n;
}

// Vendor-specific rate wins over the grade's base rate. No match → null, so the
// caller shows "no rate on file" rather than silently reaching for last_rate,
// which is exactly the price drift the rate master exists to eliminate.
export function resolveRatePerKg(rates, grade, vendorId) {
  if (!grade) return null;
  const key = String(grade).trim().toLowerCase();
  const live = (rates || []).filter(r =>
    Number(r.active) === 1 && String(r.grade ?? '').trim().toLowerCase() === key);
  const vendor = vendorId == null ? null
    : live.find(r => r.vendor_id != null && String(r.vendor_id) === String(vendorId));
  const base = live.find(r => r.vendor_id == null);
  const hit = vendor || base;
  if (!hit || !(+hit.rate_per_kg > 0)) return null;
  return { rate_per_kg: +hit.rate_per_kg, source: vendor ? 'vendor' : 'base' };
}
