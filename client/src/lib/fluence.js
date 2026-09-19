// Fluence prescription & kit master — the ONE formatter and validator.
//
// A Fluence carton is a kit box, and its printed prescription says which item
// to take, how much, and when. Every surface that shows a dose — the Fluence
// drawer in ten modules, the printed job card, the gang job card's product-wise
// table — renders it through formatSchedule/formatRxLine, and the server
// validates a save through normaliseRxPayload. One spelling, so the card on the
// press and the drawer in Planning cannot disagree about what "Morning: 1" means.
//
// Pure functions only: the server imports this file (routes/fluence.js) and the
// unit tests run it under node --test.

// The four fixed times of day, in the order a day runs. `other_*` carries
// anything else ("Before bed", "Every 6 hours").
export const RX_SLOTS = [
  { key: 'morning_qty', label: 'Morning' },
  { key: 'afternoon_qty', label: 'Afternoon' },
  { key: 'evening_qty', label: 'Evening' },
  { key: 'night_qty', label: 'Night' },
];

// Offered in the editor, never enforced — a form the list does not know is
// typed as free text and kept as written.
export const DOSE_FORMS = ['Tablet', 'Capsule', 'Softgel', 'Sachet', 'Lozenge', 'Scoop', 'Drops', 'ml', 'Application', 'Injection'];
export const FREQUENCIES = ['Once daily', 'Twice daily', 'Thrice daily', 'Alternate days', 'Once a week', 'Twice a week', 'As directed'];

// The modules a Fluence door exists in. `from` on a save is checked against
// this list so the revision history always names a real place.
export const FLUENCE_CONTEXTS = {
  planning: 'Planning',
  artwork: 'Artwork',
  job_card: 'Job Card',
  print_planning: 'Print Planning',
  printing: 'Printing',
  sorting: 'Sorting',
  pasting: 'Pasting',
  sort_paste: 'Sorting & Pasting',
  invoice: 'Invoice',
  dispatch: 'Dispatch',
  accounts: 'Accounts',
  warehouse: 'Warehouse',
  fluence_master: 'Fluence Master',
};

// Review-first modules: the drawer opens read-only and says so. Editing is
// still one deliberate click away for an authorised user.
export const REVIEW_CONTEXTS = new Set(['invoice', 'dispatch', 'accounts', 'warehouse']);

// Where a prescription came from when nobody typed it: the customer master
// ("Master from Customer.xlsx" — the one source of truth), which lists each kit's
// products and no day-wise schedule. Not a module, so a save from a screen can
// never claim it.
export const RX_FROM_CUSTOMER_MASTER = 'customer master';

// Whether a prescription changed under a job card: saved by a PERSON after the
// card was finalised. A prescription still as the customer master gives it —
// filled from the master, or re-synced with it line for line — lists the kit's
// products the card already carries, so it is never a change made under it.
export function rxChangedAfterFinalise(rx, finalisedAt) {
  if (!rx?.updated_at || !finalisedAt) return false;
  if (rx.updated_from === RX_FROM_CUSTOMER_MASTER) return false;
  return new Date(rx.updated_at) > new Date(finalisedAt);
}

// Upper-case letters, digits and '+' — nothing else. "F1-O2", "F1 O2" and
// "f1o2" are one kit; "M9O2" and "M9O2+" are two ('+' is a real variant).
export function nameKey(name) {
  return String(name ?? '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
}

const blank = v => v == null || (typeof v === 'string' && v.trim() === '');

// A quantity as typed: '' / null → null (not entered), otherwise a number.
// NaN comes back as NaN so the validator can name the field.
export function qtyValue(v) {
  if (blank(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : NaN;
}

// "1", "0.5", "2" — never "1.0" or "0.50".
export function qtyText(n) {
  if (n == null || !Number.isFinite(+n)) return '';
  return String(Math.round(+n * 1000) / 1000);
}

const COUNTABLE = new Set(['tablet', 'capsule', 'softgel', 'sachet', 'lozenge', 'scoop', 'injection', 'application', 'drop']);

// The unit a quantity is counted in: "1 tablet", "2 tablets", "5 ml".
// An unknown or empty form prints the bare number rather than a guessed unit.
export function unitFor(form, qty) {
  const f = String(form ?? '').trim();
  if (!f) return '';
  const lower = f.toLowerCase();
  const singular = lower === 'drops' ? 'drop' : lower;
  if (!COUNTABLE.has(singular)) return f;
  return +qty === 1 ? singular : `${singular}s`;
}

// Every time slot that carries a dose, in day order. A slot left blank or at
// zero is not a dose and is not printed.
export function timingParts(line) {
  if (!line) return [];
  const parts = [];
  for (const s of RX_SLOTS) {
    const n = qtyValue(line[s.key]);
    if (n != null && Number.isFinite(n) && n > 0) parts.push({ label: s.label, qty: n });
  }
  const otherQty = qtyValue(line.other_qty);
  const otherLabel = String(line.other_timing ?? '').trim();
  if (otherLabel || (otherQty != null && Number.isFinite(otherQty) && otherQty > 0)) {
    parts.push({ label: otherLabel || 'Other', qty: Number.isFinite(otherQty) && otherQty > 0 ? otherQty : null });
  }
  return parts;
}

// "Morning: 1 tablet + Night: 2 tablets". With `units: false`,
// "Morning: 1 + Night: 1" — the gang table's compact form.
export function formatSchedule(line, { units = true } = {}) {
  return timingParts(line).map(p => {
    if (p.qty == null) return p.label;
    const unit = units ? unitFor(line.dose_form, p.qty) : '';
    return `${p.label}: ${qtyText(p.qty)}${unit ? ` ${unit}` : ''}`;
  }).join(' + ');
}

// One line as it reads on paper:
// "F-TRICHO GOLD — Morning: 1 tablet + Night: 1 tablet · Once daily · After food".
export function formatRxLine(line, itemName) {
  const name = String(itemName ?? line?.item_name ?? line?.item_label ?? '').trim();
  const bits = [
    String(line?.dosage ?? '').trim(),
    formatSchedule(line),
    String(line?.frequency ?? '').trim(),
    String(line?.instructions ?? '').trim(),
  ].filter(Boolean);
  if (!name) return bits.join(' · ');
  return bits.length ? `${name} — ${bits.join(' · ')}` : name;
}

// Has anything actually been prescribed? Lines that only name an item do not
// count — a kit list copied into the editor is not a prescription yet.
export function lineHasDose(line) {
  if (!line) return false;
  return timingParts(line).length > 0
    || !blank(line.dosage) || !blank(line.frequency) || !blank(line.instructions);
}
export function rxHasContent(rx) {
  if (!rx) return false;
  return (rx.lines || []).some(lineHasDose) || !blank(rx.general_instructions);
}

// Where a prescription stands: 'full' — days and doses are prescribed;
// 'items' — the kit's products as the customer master lists them, with no
// day-wise schedule (the master carries none); 'none'.
export function rxState(rx) {
  if (rxHasContent(rx)) return 'full';
  return (rx?.lines || []).length ? 'items' : 'none';
}

const TEXT_MAX = 500;
const text = v => {
  if (blank(v)) return null;
  return String(v).trim().slice(0, TEXT_MAX);
};

// Validate and tidy a prescription save. Returns { value, errors } — errors is
// a list of plain sentences naming the line and the field, so the drawer can
// show the server's refusal exactly as written.
export function normaliseRxPayload(body) {
  const errors = [];
  const src = Array.isArray(body?.lines) ? body.lines : [];
  if (body?.lines != null && !Array.isArray(body.lines)) errors.push('Prescription lines must be a list.');
  const lines = [];
  src.forEach((raw, i) => {
    const n = i + 1;
    const innerId = raw?.inner_product_id == null || raw.inner_product_id === '' ? null : Number(raw.inner_product_id);
    if (innerId != null && !(Number.isInteger(innerId) && innerId > 0)) errors.push(`Line ${n}: the kit item is not valid.`);
    const label = text(raw?.item_label);
    if (innerId == null && !label) errors.push(`Line ${n}: choose the kit item or type what the dose is for.`);
    const line = {
      sr: n,
      inner_product_id: innerId,
      item_label: label,
      dosage: text(raw?.dosage),
      dose_form: text(raw?.dose_form),
      frequency: text(raw?.frequency),
      other_timing: text(raw?.other_timing),
      instructions: text(raw?.instructions),
      remarks: text(raw?.remarks),
    };
    for (const [key, label2] of [
      ['pack_count', 'pack count'],
      ...RX_SLOTS.map(s => [s.key, s.label.toLowerCase() + ' quantity']),
      ['other_qty', 'other-time quantity'],
    ]) {
      const v = qtyValue(raw?.[key]);
      if (Number.isNaN(v)) errors.push(`Line ${n}: the ${label2} must be a number.`);
      else if (v != null && v < 0) errors.push(`Line ${n}: the ${label2} cannot be negative.`);
      else if (v != null && v > 1000) errors.push(`Line ${n}: the ${label2} looks wrong (over 1000).`);
      line[key] = Number.isNaN(v) ? null : v;
    }
    lines.push(line);
  });
  // One item may sit on two lines when it is taken at different times (a carton
  // printing "1 lozenge Mon/Wed/Fri" and "2 on Sunday"); the same item at the
  // same time twice is a duplicate. A BARE line — the item alone, no dose and no
  // time — says nothing about when, so it never collides: the customer master
  // lists a product twice when the kit holds it twice (SKINFACT TIMELESS,
  // F-Glutasurge C at SR 7 and SR 10), and its prescription keeps both lines.
  const timingKey = l => [l.inner_product_id, ...RX_SLOTS.map(s => l[s.key] != null && l[s.key] > 0 ? 'x' : ''),
    String(l.other_timing ?? '').trim().toLowerCase()].join('|');
  const keys = lines.filter(l => l.inner_product_id != null && lineHasDose(l)).map(timingKey);
  if (keys.some((k, i) => keys.indexOf(k) !== i)) errors.push('The same kit item appears on more than one line for the same time — give each time one line.');
  return {
    errors,
    value: {
      general_instructions: text(body?.general_instructions),
      remarks: text(body?.remarks),
      lines,
    },
  };
}

// A kit composition save: which inner products, how many of each, in order.
export function normaliseComponentsPayload(body) {
  const errors = [];
  const src = Array.isArray(body?.components) ? body.components : [];
  if (!Array.isArray(body?.components)) errors.push('Components must be a list.');
  const components = src.map((raw, i) => {
    const n = i + 1;
    const innerId = Number(raw?.inner_product_id);
    if (!(Number.isInteger(innerId) && innerId > 0)) errors.push(`Item ${n}: choose an inner product.`);
    const qty = qtyValue(raw?.qty_per_kit);
    if (qty == null) errors.push(`Item ${n}: enter the quantity per kit.`);
    else if (Number.isNaN(qty) || qty <= 0) errors.push(`Item ${n}: the quantity per kit must be more than zero.`);
    const mrp = qtyValue(raw?.mrp_in_kit);
    if (Number.isNaN(mrp) || (mrp != null && mrp < 0)) errors.push(`Item ${n}: the MRP must be a number, zero or more.`);
    return {
      sr: n,
      inner_product_id: innerId,
      qty_per_kit: Number.isFinite(qty) ? qty : null,
      mrp_in_kit: Number.isFinite(mrp) ? mrp : null,
      remarks: text(raw?.remarks),
    };
  });
  const ids = components.map(c => c.inner_product_id);
  if (new Set(ids).size !== ids.length) errors.push('An inner product is listed twice — raise its quantity instead.');
  return { errors, value: { components } };
}

// Carton dimensions, as typed: blank stays blank (unknown), never zero.
export function normaliseDims(body) {
  const errors = [];
  const out = {};
  for (const [key, label] of [['carton_l', 'length'], ['carton_w', 'width'], ['carton_h', 'height']]) {
    const v = qtyValue(body?.[key]);
    if (Number.isNaN(v)) errors.push(`The carton ${label} must be a number.`);
    else if (v != null && v <= 0) errors.push(`The carton ${label} must be more than zero, or left blank.`);
    out[key] = Number.isFinite(v) && v > 0 ? v : null;
  }
  return { errors, value: out };
}

// "118 × 58 × 93 mm", or '' while any side is unknown.
export function formatDims(r) {
  const d = [r?.carton_l, r?.carton_w, r?.carton_h];
  if (d.some(v => v == null || v === '')) return '';
  return `${d.map(qtyText).join(' × ')} mm`;
}

// The customer list's price for a kit, in the form it can honestly be shown
// beside the carton's MRP. An itemised kit's lines add up to the kit. A
// flat-priced kit repeats ONE figure on every line — on the Topico, CGC and
// Umang kits that figure is the carton's own MRP — so adding its lines up
// multiplies the price and is never shown. `linePrices` are the kit's line MRPs.
export function kitListPrice(kit, linePrices) {
  if (!kit) return null;
  if (kit.kit_type === 'Flat-priced') {
    const prices = (linePrices || []).map(v => (v == null || v === '' ? NaN : Number(v)));
    const distinct = new Set(prices);
    return prices.length && distinct.size === 1 && Number.isFinite(prices[0]) ? { kind: 'per_line', amount: prices[0] } : null;
  }
  return kit.kit_total_mrp != null ? { kind: 'total', amount: Number(kit.kit_total_mrp) } : null;
}

// A part carton (Topico filler, inner box, leaflet, tray, separator) shows the
// kit of its outer carton; this is how it names itself — "Leaflet of FP-263".
export function partLabel(partOf) {
  if (!partOf?.part) return '';
  const kind = partOf.part.charAt(0).toUpperCase() + partOf.part.slice(1);
  return partOf.outer_code ? `${kind} of ${partOf.outer_code}` : kind;
}

// Every carton a kit is printed as — its outer carton, then its parts. Empty for
// a kit printed as one carton, which is every kit but the Topico ones.
export function kitCartons(outer, parts) {
  if (!outer?.code || !parts?.length) return [];
  return [{ product_id: outer.product_id, code: outer.code, part: 'outer carton' },
    ...parts.map(p => ({ product_id: p.product_id, code: p.code, part: p.part }))];
}
