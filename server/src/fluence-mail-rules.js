// The rules for what the office AVS reads from Fluence's mails (owner, 18 Nov 2026: "the new MRP of a product and the
// prescription should be auto-saved in the Fluence module and the master module … I just want the system to fetch it
// whenever there is a new email from Fluence"). Design: plans/2026-11-18-fluence-mail-masters-design.md.
// Pure, so they are tested on their own; fluence-mail.js does the saving.
import { nameKey, sameMrp } from '../../client/src/lib/fluence.js';

// A reading whose outcome is known — what the bell (fluence-mail.js) and the "done by the system" notice
// (artwork-notice.js) tell, once each.
export const SETTLED = ['saved', 'same', 'held', 'not_matched', 'compared'];

const text = v => (v == null ? null : String(v).replace(/\s+/g, ' ').trim() || null);
// "₹ 1,250.00", "Rs. 450/-" → 1250, 450; '' / null → null; anything else unreadable → NaN (the reading becomes unsure)
const money = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v).replace(/[₹,\s]|rs\.?|inr|\/-|\/=/gi, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
const plain = n => (n == null ? '—' : String(Number(n)));
const LINE_FIELDS = ['dosage', 'dose_form', 'frequency', 'pack_count', 'morning', 'morning_qty', 'afternoon', 'afternoon_qty', 'evening', 'evening_qty',
  'night', 'night_qty', 'other_timing', 'other_qty', 'instructions'];
const saysSomething = (o, keys) => keys.some(k => o?.[k] != null && String(o[k]).trim() !== '');

// What the robot filed → a clean reading. A reading that does not say it is sure, whose figures cannot be read, whose
// prescription has no line, or a line or price with no item, is unsure: it is never saved without a person.
export function normaliseReading(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const unsure = Array.isArray(r.unsure) ? r.unsure.map(String) : [];
  let sure = r.sure === true;
  const num = (v, field) => { const n = money(v); if (Number.isNaN(n)) { sure = false; unsure.push(field); return null; } return n; };
  const rx = r.prescription && typeof r.prescription === 'object' ? r.prescription : null;
  const rawLines = Array.isArray(rx?.lines) ? rx.lines : [];
  rawLines.forEach((l, i) => { if (!text(l?.item) && saysSomething(l, LINE_FIELDS)) unsure.push(`prescription.lines.${i}.item`); });
  const lines = rawLines.map((l, i) => ({
    item: text(l?.item),
    dosage: text(l?.dosage), dose_form: text(l?.dose_form), frequency: text(l?.frequency),
    pack_count: num(l?.pack_count, `prescription.lines.${i}.pack_count`),
    // the robot writes morning / … ; a clean reading read back says morning_qty / … — both are taken
    morning_qty: num(l?.morning ?? l?.morning_qty, `prescription.lines.${i}.morning`),
    afternoon_qty: num(l?.afternoon ?? l?.afternoon_qty, `prescription.lines.${i}.afternoon`),
    evening_qty: num(l?.evening ?? l?.evening_qty, `prescription.lines.${i}.evening`),
    night_qty: num(l?.night ?? l?.night_qty, `prescription.lines.${i}.night`),
    other_timing: text(l?.other_timing), other_qty: num(l?.other_qty, `prescription.lines.${i}.other_qty`),
    instructions: text(l?.instructions),
  })).filter(l => l.item);
  if (rx && !lines.length) unsure.push('prescription.lines');
  const m = r.mrp && typeof r.mrp === 'object' ? r.mrp : null;
  const rawItems = Array.isArray(m?.items) ? m.items : [];
  rawItems.forEach((x, i) => { if (!text(x?.item) && saysSomething(x, ['mrp', 'qty'])) unsure.push(`mrp.items.${i}.item`); });
  const items = rawItems.map((x, i) => ({
    item: text(x?.item), qty: num(x?.qty, `mrp.items.${i}.qty`), mrp: num(x?.mrp, `mrp.items.${i}.mrp`),
  })).filter(x => x.item);
  return {
    kit_name: text(r.kit_name), kit_code: text(r.kit_code)?.toUpperCase() ?? null,
    prescription: rx ? { general_instructions: text(rx.general_instructions), lines } : null,
    mrp: m ? { kit_total: num(m.kit_total, 'mrp.kit_total'), items } : null,
    sure: sure && !unsure.length, unsure: [...new Set(unsure)],
  };
}

// The live kits of exactly the reading's name (two of a name is not one kit).
export function namedKits(reading, kits) {
  const key = nameKey(reading?.kit_name);
  return key ? kits.filter(k => !k.superseded_by_kit_id && nameKey(k.kit_name) === key) : [];
}

// The kit a reading is about: the FP code it names; else the kit the artwork job's carton reads (its own, or its outer
// carton's — productKitId); else the ONE live kit of exactly that name. Two of a name, or none → null (never a guess).
// kits: [{ id, kit_name, product_id, product_code, superseded_by_kit_id }]
export function matchKit(reading, { kits, productKitId = null }) {
  const code = String(reading?.kit_code || '').toUpperCase();
  if (code) {
    const byCode = kits.filter(k => String(k.product_code || '').toUpperCase() === code);
    if (byCode.length === 1) return byCode[0];
  }
  if (productKitId) {
    const own = kits.find(k => k.id === productKitId);
    if (own) return own;
  }
  const byName = namedKits(reading, kits);
  return byName.length === 1 ? byName[0] : null;
}

// An item's name → its inner product (by the module's name key). Unknown → null.
export function innerFor(name, inners) {
  const key = nameKey(name);
  if (!key) return null;
  const hit = inners.filter(p => nameKey(p.name) === key);
  return hit.length === 1 ? hit[0].id : null;
}

// Anik's rule of 31 Oct: an MRP more than 25 % below the master is not saved without a person.
export const mrpDropTooBig = (oldV, newV) => oldV != null && newV != null && Number(oldV) > 0 && Number(newV) < Number(oldV) * 0.75;
// And more than double the master is a figure misread (a decimal point lost) until a person says otherwise.
export const mrpRiseTooBig = (oldV, newV) => oldV != null && newV != null && Number(oldV) > 0 && Number(newV) > Number(oldV) * 2;

// Why a reading may not be saved by itself. master: { kit_total_mrp, carton_mrp (products.mrp, the MRP printed),
// components: [{ inner_product_id, name, mrp_in_kit }] }; personChangedAfterMail: { by, at, what } | null; newerMail:
// { at } | null (a newer mail already saved to this kit).
export function holdsFor({ reading, master, innerIdOf, personChangedAfterMail = null, newerMail = null }) {
  const out = [];
  if (!reading.sure) out.push(`the robot was not sure of: ${reading.unsure.length ? reading.unsure.join(', ') : 'what it read'}`);
  const total = reading.mrp?.kit_total;
  const kt = master?.kit_total_mrp ?? null;
  const ct = master?.carton_mrp ?? null;
  const cartonOwn = ct != null && !sameMrp(ct, kt);       // the carton says something the kit total does not
  if (total != null) {
    if (mrpDropTooBig(kt, total)) out.push(`kit MRP ${plain(kt)} → ${plain(total)} is more than 25 % lower`);
    if (cartonOwn && mrpDropTooBig(ct, total)) out.push(`carton MRP ${plain(ct)} → ${plain(total)} is more than 25 % lower`);
    if (mrpRiseTooBig(kt, total)) out.push(`kit MRP ${plain(kt)} → ${plain(total)} is more than double — a misread figure?`);
    if (cartonOwn && mrpRiseTooBig(ct, total)) out.push(`carton MRP ${plain(ct)} → ${plain(total)} is more than double — a misread figure?`);
    if (kt != null && cartonOwn && !sameMrp(total, ct)) {
      out.push(`the carton MRP ${plain(ct)} and the kit total ${plain(kt)} already disagree — a person decides which is right`);
    }
  }
  for (const it of reading.mrp?.items || []) {
    const id = innerIdOf(it.item);
    const was = (master?.components || []).find(c => c.inner_product_id === id);
    if (was && mrpDropTooBig(was.mrp_in_kit, it.mrp)) out.push(`${it.item} MRP ${plain(was.mrp_in_kit)} → ${plain(it.mrp)} is more than 25 % lower`);
    if (was && mrpRiseTooBig(was.mrp_in_kit, it.mrp)) out.push(`${it.item} MRP ${plain(was.mrp_in_kit)} → ${plain(it.mrp)} is more than double — a misread figure?`);
  }
  if (personChangedAfterMail) {
    out.push(`the ${personChangedAfterMail.what || 'kit'} was changed by ${personChangedAfterMail.by} after this mail (${String(personChangedAfterMail.at instanceof Date ? personChangedAfterMail.at.toISOString() : personChangedAfterMail.at).slice(0, 10)}) — a mail does not undo a person's change`);
  }
  if (newerMail) {
    out.push(`a newer mail (${String(newerMail.at instanceof Date ? newerMail.at.toISOString() : newerMail.at).slice(0, 10)}) already set this kit — this older one is not applied`);
  }
  return out;
}

// An artwork for a kit we have says what is in the box only through what it prints. A printed item the kit does not
// hold, or an item of the kit (not its packaging — inner box, filler, leaflet — which is never printed) the artwork
// does not print, means the contents differ: a person looks. masterComponents: [{ inner_product_id, name, kind }].
export function contentsDiffer(reading, { masterComponents = [], innerIdOf }) {
  if (!reading.prescription) return [];
  const inKit = new Set(masterComponents.map(c => c.inner_product_id));
  const printedIds = new Set();
  const seen = new Set();
  const out = [];
  for (const n of [...reading.prescription.lines.map(l => l.item), ...(reading.mrp?.items || []).map(x => x.item)]) {
    const id = innerIdOf(n);
    if (id != null) printedIds.add(id);
    const key = nameKey(n);
    if (seen.has(key)) continue;
    seen.add(key);
    if (id == null || !inKit.has(id)) out.push(`printed ${n}, which is not in this kit`);
  }
  for (const c of masterComponents) {
    if (c.kind !== 'packaging' && !printedIds.has(c.inner_product_id)) out.push(`the kit has ${c.name}, which the artwork does not print`);
  }
  return out;
}

const TIMING = ['morning_qty', 'afternoon_qty', 'evening_qty', 'night_qty', 'other_timing', 'other_qty'];
const KEPT_WHEN_NOT_PRINTED = ['dosage', 'dose_form', 'pack_count', 'frequency', 'instructions'];
const lineOf = (l, id) => ({
  inner_product_id: id ?? null, item_label: id == null ? l.item : null,
  dosage: l.dosage, dose_form: l.dose_form, pack_count: l.pack_count, frequency: l.frequency,
  morning_qty: l.morning_qty, afternoon_qty: l.afternoon_qty, evening_qty: l.evening_qty, night_qty: l.night_qty,
  other_timing: l.other_timing, other_qty: l.other_qty, instructions: l.instructions, remarks: null,
});
// A printed line over the master's line for the same item: the timings printed are the whole dosing (a timing the
// artwork no longer prints is gone); a field the artwork does not print at all (the dose form, the pack count) and the
// line's remarks are kept.
function overMaster(printed, was) {
  if (!was) return printed;
  const out = { ...printed, remarks: was.remarks ?? null };
  const timed = TIMING.some(k => printed[k] != null);
  for (const k of TIMING) out[k] = timed ? (printed[k] ?? null) : (was[k] ?? null);
  for (const k of KEPT_WHEN_NOT_PRINTED) out[k] = printed[k] ?? was[k] ?? null;
  return out;
}

// The body the Fluence module's save takes (saveKitAndRx): what is in the box and the prescription.
//   - an MRP-only reading (a sheet): the items' MRPs; the prescription exactly as it is;
//   - an artwork for a kit we have: its items stay as they are (quantities, remarks, packaging), the MRPs printed are
//     taken, each printed item's lines take the place of that item's lines (over what was not printed), every other
//     line stays; a printed item the kit does not hold is added only when a person applies it (contentsDiffer holds it
//     otherwise);
//   - an artwork for a kit this reading makes (creating): the items as printed.
export function payloadFor(reading, { masterComponents = [], masterRx = null, innerIdOf, creating = false }) {
  const mrpRead = new Map((reading.mrp?.items || []).map(x => [innerIdOf(x.item), x]).filter(([id]) => id != null));
  const priced = c => ({ ...c, mrp_in_kit: mrpRead.get(c.inner_product_id)?.mrp ?? c.mrp_in_kit });
  if (!reading.prescription) {
    return {
      components: masterComponents.map(priced),
      general_instructions: masterRx?.general_instructions ?? null,
      remarks: masterRx?.remarks ?? null,
      lines: (masterRx?.lines || []).map(l => ({ ...l })),
    };
  }
  const printed = reading.prescription.lines.map(l => ({ id: innerIdOf(l.item), l }));
  const order = [];
  for (const id of [...printed.map(p => p.id), ...(reading.mrp?.items || []).map(x => innerIdOf(x.item))]) {
    if (id != null && !order.includes(id)) order.push(id);
  }
  const fresh = id => ({ inner_product_id: id, qty_per_kit: mrpRead.get(id)?.qty ?? 1, mrp_in_kit: mrpRead.get(id)?.mrp ?? null, remarks: null });
  if (creating) {
    return {
      components: order.map(fresh),
      general_instructions: reading.prescription.general_instructions,
      remarks: null,
      lines: printed.map(({ id, l }) => lineOf(l, id)),
    };
  }
  const components = masterComponents.map(priced);
  for (const id of order) if (!components.some(c => c.inner_product_id === id)) components.push(fresh(id));
  const byItem = new Map();
  for (const { id, l } of printed) if (id != null) byItem.set(id, [...(byItem.get(id) || []), l]);
  const masterLines = masterRx?.lines || [];
  const lines = [];
  const placed = new Set();
  for (const ml of masterLines) {
    const id = ml.inner_product_id;
    if (id == null || !byItem.has(id)) { lines.push({ ...ml }); continue; }
    if (placed.has(id)) continue;
    placed.add(id);
    const was = masterLines.filter(x => x.inner_product_id === id);
    byItem.get(id).forEach((l, i) => lines.push(overMaster(lineOf(l, id), was[i] ?? was[0])));
  }
  for (const [id, ls] of byItem) if (!placed.has(id)) ls.forEach(l => lines.push(lineOf(l, id)));
  for (const { id, l } of printed) if (id == null) lines.push(lineOf(l, null));
  return {
    components,
    general_instructions: reading.prescription.general_instructions ?? masterRx?.general_instructions ?? null,
    remarks: masterRx?.remarks ?? null,
    lines,
  };
}
