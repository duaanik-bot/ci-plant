// Kit Studio — the pure half: how a studio document maps onto the kit_studio_*
// rows and the Fluence master, with no database in sight. routes/kitstudio.js
// does the reading and writing; everything here is plain data in, data out, so
// it can be tested without a Postgres.
//
// The studio page keeps its data as documents (a kit, an inner product, a
// draft, the settings). In the ERP a document is split three ways:
//
//   • promoted columns — name, family, carton size and how sure we are of it —
//     so any other screen can query them;
//   • `data` — everything else the studio keeps (layout, remarks, history …);
//   • the ERP's own facts, NEVER stored with the studio: what is in a kit
//     (fluence_kit_components), a kit's billing code and party serial (the
//     linked product / fluence_kits), an inner product's name, MRP and
//     confirmed size (fluence_inner_products). They are laid over the document
//     every time it is read, so the studio can never drift from the master.

export const SIZE_STATUSES = ['CONFIRMED', 'PROPOSED', 'VERIFY', 'CONFLICT', 'MISSING'];

// Fields the page sends that the ERP owns or computes — dropped before storing.
// (A kit's `code` IS kept: it is the fallback shown while the kit has no linked
// product whose customer item code could answer instead.)
export const ERP_OWNED = ['party', 'erp', 'updatedAt', 'updatedBy'];
// Fields that live in their own columns rather than in `data`.
const KIT_PROMOTED = ['name', 'family', 'L', 'W', 'H', 'sizeStatus', 'sizeSource'];
const PRODUCT_PROMOTED = ['name', 'L', 'W', 'H', 'sizeStatus'];

const IDS = /^[A-Za-z0-9_-]{1,64}$/;
export const validId = id => typeof id === 'string' && IDS.test(id);

// Upper-case letters, digits and '+' — the Fluence master's de-duplication key
// (client/src/lib/fluence.js nameKey), repeated here so this file needs nothing.
export const nameKey = name => String(name ?? '').toUpperCase().replace(/[^A-Z0-9+]/g, '');

// A positive number, or null. '' / 0 / junk are "not known".
export function dim(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// {L, W, H} when all three sides are known, otherwise null.
export function dimsOf(d) {
  const L = dim(d?.L), W = dim(d?.W), H = dim(d?.H);
  return L && W && H ? { L, W, H } : null;
}

const numText = n => String(Math.round(Number(n) * 100) / 100);

// The ERP product master's spelling of a carton size: "138X75X108".
export const sizeText = d => `${numText(d.L)}X${numText(d.W)}X${numText(d.H)}`;

// "138X75X108", "140x78x108", "138 x 75 x 108 mm", "130X115X130MM" → {L, W, H};
// anything else → null.
export function parseSizeText(s) {
  const m = String(s ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?$/i);
  return m ? dimsOf({ L: m[1], W: m[2], H: m[3] }) : null;
}

export const sameDims = (a, b) => !!a && !!b && +a.L === +b.L && +a.W === +b.W && +a.H === +b.H;
// The same carton turned another way still reads as the same carton.
export const sameCarton = (a, b) => !!a && !!b
  && [a.L, a.W, a.H].map(Number).sort((x, y) => x - y).join('x') === [b.L, b.W, b.H].map(Number).sort((x, y) => x - y).join('x');

export const statusOf = v => (SIZE_STATUSES.includes(v) ? v : 'MISSING');

const omit = (obj, keys) => {
  const out = { ...(obj || {}) };
  for (const k of keys) delete out[k];
  return out;
};
const text = v => {
  const t = String(v ?? '').trim();
  return t || null;
};
const money = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

// ── Splitting a document the page sent ──────────────────────────────────────

export function splitKit(doc) {
  const errors = [];
  const name = text(doc?.name);
  if (!name) errors.push('The kit needs a name.');
  const dims = dimsOf(doc);
  for (const k of ['L', 'W', 'H']) {
    if (doc?.[k] != null && doc[k] !== '' && dim(doc[k]) == null) errors.push(`The carton ${k} must be a number more than zero.`);
  }
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const clean = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || !it.pid) continue;
    const pid = String(it.pid);
    if (seen.has(pid)) { errors.push('A product is listed twice in this kit — raise its quantity instead.'); continue; }
    seen.add(pid);
    const q = Number(it.q ?? 1);
    if (!(Number.isFinite(q) && q > 0)) errors.push('Every quantity must be more than zero.');
    const mrp = money(it.mrp);
    if (Number.isNaN(mrp)) errors.push('An MRP must be a number, zero or more.');
    clean.push({ pid, q: Number.isFinite(q) && q > 0 ? q : 1, mrp: Number.isNaN(mrp) ? null : mrp });
  }
  return {
    errors,
    row: {
      name,
      family: text(doc?.family),
      carton_l: dims?.L ?? null,
      carton_w: dims?.W ?? null,
      carton_h: dims?.H ?? null,
      size_status: statusOf(doc?.sizeStatus),
      size_source: text(doc?.sizeSource),
      data: { ...omit(doc, [...KIT_PROMOTED, ...ERP_OWNED]), items: clean },
    },
    items: clean,
  };
}

export function splitProduct(doc) {
  const errors = [];
  const name = text(doc?.name);
  if (!name) errors.push('The product needs a name.');
  for (const k of ['L', 'W', 'H']) {
    if (doc?.[k] != null && doc[k] !== '' && dim(doc[k]) == null) errors.push(`The carton ${k} must be a number more than zero.`);
  }
  const mrp = money(doc?.mrp);
  if (Number.isNaN(mrp)) errors.push('The MRP must be a number, zero or more.');
  const dims = dimsOf(doc);
  return {
    errors,
    mrp: Number.isNaN(mrp) ? null : mrp,
    dims,
    row: {
      name,
      carton_l: dims?.L ?? null,
      carton_w: dims?.W ?? null,
      carton_h: dims?.H ?? null,
      size_status: statusOf(doc?.sizeStatus),
      data: { ...omit(doc, [...PRODUCT_PROMOTED, ...ERP_OWNED]), mrp: Number.isNaN(mrp) ? null : mrp },
    },
  };
}

export function splitDraft(doc) {
  return { name: text(doc?.name), data: omit(doc, ['updatedAt', 'updatedBy']) };
}

// The clearance rules: numbers only, each a small positive figure.
export const SETTINGS_KEYS = ['cL', 'cW', 'cH', 'dLmin', 'dLmax', 'dWmin', 'dWmax', 'dHmin', 'dHmax'];
export function splitSettings(doc) {
  const errors = [];
  const data = omit(doc, ['updatedAt', 'updatedBy']);
  for (const k of SETTINGS_KEYS) {
    if (k in data) {
      const n = Number(data[k]);
      if (!(Number.isFinite(n) && n >= 0 && n <= 500)) errors.push(`${k} must be a number of millimetres.`);
      else data[k] = n;
    }
  }
  return { errors, data };
}

// What the Fluence master should hold for an inner product, given the studio's
// view of it: its size only once the size is CONFIRMED. Anything less is "not
// known yet" to the master (its columns say NULL, never a guess).
export function masterDimsFor(row) {
  const d = dimsOf({ L: row.carton_l, W: row.carton_w, H: row.carton_h });
  return row.size_status === 'CONFIRMED' && d ? d : null;
}

// ── Composing the document the page reads ───────────────────────────────────

const iso = t => (t ? new Date(t).toISOString() : undefined);
const codeValue = c => (c == null || c === '' ? null : /^\d+$/.test(String(c)) ? Number(c) : String(c));
const numOrNull = v => (v == null ? null : Number(v));

// kit: a kit_studio_kits row (or null for a Fluence kit the studio has not
// saved yet); fk: its fluence_kits row joined to the linked product (or null);
// comps: that kit's components in order; pidOf(innerId) → the studio product id.
export function kitDoc(kit, fk, comps, pidOf) {
  const data = kit?.data || {};
  const doc = {
    ...data,
    name: kit?.name ?? fk?.kit_name ?? '',
    family: kit?.family ?? data.family ?? '',
    L: numOrNull(kit?.carton_l), W: numOrNull(kit?.carton_w), H: numOrNull(kit?.carton_h),
    sizeStatus: kit?.size_status ?? 'MISSING',
    sizeSource: kit?.size_source ?? '',
    status: data.status ?? 'Active',
    origin: data.origin ?? 'master',
    updatedAt: iso(kit?.updated_at),
    updatedBy: kit?.updated_by ?? undefined,
  };
  if (!kit && fk) {
    // Never saved in the studio: start from what the ERP already says.
    const d = parseSizeText(fk.product_size);
    if (d) Object.assign(doc, d, { sizeStatus: 'VERIFY', sizeSource: 'ERP product size' });
    doc.remarks = '';
  }
  if (fk) {
    const own = fk.source_ref === `kit-studio:${kit?.id}`;
    if (!own) doc.name = fk.kit_name;
    doc.party = fk.party_sl_no ?? null;
    doc.code = codeValue(fk.party_item_code) ?? codeValue(data.code);
    doc.items = (comps || []).map(c => ({ pid: pidOf(c.inner_product_id), q: Number(c.qty_per_kit), mrp: numOrNull(c.mrp_in_kit) }));
    doc.erp = {
      kitId: fk.id,
      productId: fk.product_id ?? null,
      productCode: fk.product_code ?? null,
      productName: fk.product_name ?? null,
      size: fk.product_size ?? null,
      superseded: fk.superseded_by_kit_id != null,
      own,
    };
  } else {
    doc.code = codeValue(data.code) ?? null;
    doc.items = Array.isArray(data.items) ? data.items : [];
    doc.erp = null;
  }
  return doc;
}

// ── The kit carton in the ERP product master ────────────────────────────────
//
// A kit finalised in the studio is printed as a carton, and the carton is an ERP
// product: the next code in the Fluence series (FP-373), the Fluence billing code
// invoices run on (20251368), and a print spec taken from the kit it is modelled
// on. When the carton is ALREADY in the product master — an order brought it in
// before the kit was designed here — the kit is linked to that product instead,
// so the plant never carries one carton under two codes.

// Fluence's 8-digit billing code: 20251001 … 20251367 on record in Sept 2026.
export const BILLING_CODE = /^20\d{6}$/;
export function billingCodeOf(v) {
  const t = String(v ?? '').trim();
  return BILLING_CODE.test(t) ? t : null;
}

// The code after the highest on record, or null when there is none to follow.
export function nextBillingCode(codes) {
  let top = null;
  for (const c of codes || []) {
    const t = billingCodeOf(c);
    if (t && (top == null || +t > +top)) top = t;
  }
  return top == null ? null : String(+top + 1);
}

// The print spec a new carton takes from the kit carton it is modelled on: the
// board and the print process always; the die and the sheet layout only when the
// two cartons are the same size — a different size needs its own die, and
// Planning lays out its sheet. Never the artwork's own details (its codes, shade
// card, Pantone references, emboss block) and never the price.
export const SPEC_COPIED = [
  'board_material_id', 'board_name', 'board_grade', 'gsm', 'colors', 'colour_type', 'print_process',
  'cmyk_colours', 'pantone_colours', 'metallic_colours', 'coating', 'special', 'emboss', 'leafing', 'leafing_colour',
  'pasting_type', 'product_type', 'wastage_pct',
];
export const SPEC_SAME_CARTON = ['die_number', 'tool_id', 'ups', 'child_l', 'child_w', 'parent_l', 'parent_w'];

// The new product's columns. `ref` is the product the spec is copied from, or
// null — then it parks on the placeholder board (`boardId`) and claims nothing
// else. A column left out takes the table's default: "not known yet". Always
// spec_incomplete, so Masters shows it as a spec still to finish.
export function newProductRow({ customerId, name, code, billingCode = null, mrp = null, size = null, ref = null, sameSize = false, boardId = null }) {
  const row = {
    customer_id: customerId, name, code, internal_carton_code: code,
    party_item_code: billingCode, mrp, size, product_type: 'carton', active: 1, spec_incomplete: 1,
  };
  if (ref) {
    for (const c of SPEC_COPIED) if (ref[c] != null) row[c] = ref[c];
    if (sameSize) for (const c of SPEC_SAME_CARTON) if (ref[c] != null) row[c] = ref[c];
  } else {
    row.board_material_id = boardId;
  }
  return row;
}

// What the product-master dialog sends: the product's name (a new product only),
// the billing code — or blank until Fluence issues one — the carton's MRP (or
// blank) and the product to copy the print spec from.
export function productInput(body, { create = true } = {}) {
  const errors = [];
  const name = text(body?.name)?.replace(/\s+/g, ' ') ?? null;
  if (create && !name) errors.push('The product needs a name.');
  const rawCode = text(body?.billing_code);
  const billingCode = rawCode ? billingCodeOf(rawCode) : null;
  if (rawCode && !billingCode) errors.push(`${rawCode} is not a Fluence billing code — it is 8 digits, like 20251368.`);
  const mrp = money(body?.mrp);
  if (Number.isNaN(mrp) || mrp === 0) errors.push('The MRP must be a number more than zero, or left blank.');
  const rawRef = body?.ref_product_id;
  const refId = rawRef == null || rawRef === '' ? null : Number(rawRef);
  if (refId != null && !(Number.isInteger(refId) && refId > 0)) errors.push('Pick the kit to copy the print spec from again.');
  return { errors, name, billingCode, mrp: Number.isNaN(mrp) || mrp === 0 ? null : mrp, refId };
}

// Is this kit a product already in the master? Its name against a product's:
// 1 the same, 0.9 contained in it ("Shed Control" in "DR. FACT SHED CONTROL"),
// otherwise the share of the kit's own words the product carries. The words
// every Fluence carton shares (DR FACT, SKIN FACT …) say nothing about which
// carton it is, so they do not count.
const nameWords = s => String(s ?? '').toUpperCase().split(/[^A-Z0-9+]+/).filter(Boolean);
const COMMON_WORDS = new Set(['DR', 'FACT', 'DRFACT', 'SKIN', 'SKINFACT', 'HAIR', 'HAIRFACT', 'PRO', 'PROFACT', 'KIT', 'THE', 'AND', 'FOR', 'OF']);
export function nameMatch(kitName, productName) {
  const kit = nameKey(kitName), prod = nameKey(productName);
  if (!kit || !prod) return 0;
  if (kit === prod) return 1;
  const contained = prod.includes(kit) ? 0.9 : 0;
  const words = nameWords(kitName).filter(w => !COMMON_WORDS.has(w));
  if (!words.length) return contained;
  const have = new Set(nameWords(productName));
  const found = words.filter(w => have.has(w) || (w.length >= 4 && prod.includes(w))).length;
  return Math.max(contained, Math.round((0.85 * found / words.length) * 100) / 100);
}

// Fluence products no kit holds yet, best match first. The same carton size
// lifts a product that already matches on name — never one that does not.
export function rankMatches(kit, products) {
  return (products || []).map(p => {
    const name = nameMatch(kit?.name, p.name);
    const same = sameCarton(parseSizeText(p.size), kit?.dims);
    return { ...p, same_size: same, score: Math.round((name + (same && name > 0 ? 0.1 : 0)) * 100) / 100 };
  }).sort((a, b) => b.score - a.score || String(b.code).localeCompare(String(a.code), undefined, { numeric: true }));
}

// prod: a kit_studio_products row (or null); inner: its fluence_inner_products row (or null).
export function productDoc(prod, inner) {
  const data = prod?.data || {};
  const doc = {
    ...data,
    name: prod?.name ?? inner?.name ?? '',
    L: numOrNull(prod?.carton_l), W: numOrNull(prod?.carton_w), H: numOrNull(prod?.carton_h),
    sizeStatus: prod?.size_status ?? 'MISSING',
    status: data.status ?? 'Active',
    remarks: data.remarks ?? '',
    updatedAt: iso(prod?.updated_at),
    updatedBy: prod?.updated_by ?? undefined,
  };
  if (inner) {
    doc.name = inner.name;
    doc.mrp = numOrNull(inner.standard_mrp);
    const master = dimsOf({ L: inner.carton_l, W: inner.carton_w, H: inner.carton_h });
    if (master) {
      // The master's size is a confirmed size, whoever typed it.
      if (!sameDims(master, doc)) doc.sizeSource = 'Fluence Master';
      Object.assign(doc, master, { sizeStatus: 'CONFIRMED' });
    } else if (doc.sizeStatus === 'CONFIRMED') {
      // Confirmed here once, cleared in the Fluence master since: not confirmed now.
      doc.sizeStatus = 'VERIFY';
    }
    if (!prod) doc.status = +inner.active ? 'Active' : 'Inactive';
    doc.erp = { innerId: inner.id, kind: inner.kind, own: inner.source === 'kit-studio' };
  } else {
    doc.erp = null;
  }
  return doc;
}
