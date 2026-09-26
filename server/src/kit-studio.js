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

// "138X75X108", "140x78x108", "138 x 75 x 108 mm" → {L, W, H}; anything else → null.
export function parseSizeText(s) {
  const m = String(s ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?$/);
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
