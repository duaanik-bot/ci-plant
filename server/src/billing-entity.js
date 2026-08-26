// Which name the plant bills and certifies under.
//
// Colour Impressions is the house entity. Galpha Laboratories' cartons go out
// as Darbi Print Pack — a separate registration, not a letterhead swap — so the
// entity carries its own GSTIN, address and state, and place of supply is
// computed against THAT state.
//
// A document freezes its entity at creation (invoices.billing_entity_id,
// coas.billing_entity_id). Repointing a customer afterwards must not rewrite
// paperwork the customer already holds.

// The values billing.js carried as a constant before entities existed. They are
// the last resort only — a database with no billing_entities row at all — so an
// invoice never prints a blank letterhead.
export const HOUSE_FALLBACK = {
  name: 'Colour Impressions',
  tagline: 'Manufacturers of Printed Packaging Cartons — Pharma & FMCG',
  address: 'Vill Shamdo Road, Rajpura–Chandigarh Highway, Rajpura, Punjab 140401',
  city: 'Rajpura',
  state: 'Punjab',
  state_code: '03',
  gstin: '03BCMPD4475P1Z7',
  hsn: '48192010',
  gst_rate: 18,
  jurisdiction: 'Patiala',
};

// A GSTIN carries its own check digit, so a typo is detectable without asking
// anyone. Positions 1-14 are weighted 1,2,1,2…; each product is folded
// (quotient + remainder over 36) and the 15th character completes the sum to a
// multiple of 36.
//
// This is not decoration. The value this codebase shipped as Colour
// Impressions' GSTIN — 03AABCC1234D1Z5 — fails it: a placeholder that had been
// printing on live tax invoices and sitting in the PO importer as the number it
// must never mistake for a customer, where it silently matched nothing.
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function isValidGstin(gstin) {
  const g = String(gstin ?? '').trim().toUpperCase();
  if (!/^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

// A second entity may be registered before its GSTIN and address have been
// entered in Masters. Rather than print an invoice with a blank GSTIN — which
// is worse than a wrong name — the tax identity falls back to the house
// entity's, and `incomplete` tells the UI to say so.
function withFallback(entity, house) {
  if (!entity) return { ...HOUSE_FALLBACK, ...(house || {}) };
  const base = { ...HOUSE_FALLBACK, ...(house || {}) };
  const blank = v => v == null || String(v).trim() === '';
  const missing = ['gstin', 'address', 'state'].filter(k => blank(entity[k]));
  return {
    ...entity,
    tagline: blank(entity.tagline) ? base.tagline : entity.tagline,
    address: blank(entity.address) ? base.address : entity.address,
    city: blank(entity.city) ? base.city : entity.city,
    state: blank(entity.state) ? base.state : entity.state,
    state_code: blank(entity.state_code) ? base.state_code : entity.state_code,
    gstin: blank(entity.gstin) ? base.gstin : entity.gstin,
    hsn: blank(entity.hsn) ? base.hsn : entity.hsn,
    gst_rate: entity.gst_rate ?? base.gst_rate,
    jurisdiction: blank(entity.jurisdiction) ? base.jurisdiction : entity.jurisdiction,
    incomplete: missing.length ? missing : undefined,
  };
}

// Resolve an entity row by id, then by the customer's mapping, then the default.
// `oc` is the transaction's one() when called inside tx().
export async function billingEntity({ entity_id = null, customer_id = null }, oc) {
  const house = await oc('SELECT * FROM billing_entities WHERE is_default=1 LIMIT 1');
  let entity = null;
  if (entity_id != null) {
    entity = await oc('SELECT * FROM billing_entities WHERE id=$1', [entity_id]);
  } else if (customer_id != null) {
    entity = await oc(`
      SELECT be.* FROM customers c
      JOIN billing_entities be ON be.id = c.billing_entity_id
      WHERE c.id=$1`, [customer_id]);
  }
  return withFallback(entity || house, house);
}

// The place-of-supply test. Same state as the SELLING entity → CGST+SGST,
// otherwise IGST. Reading the entity's state rather than a hardcoded 'Punjab'
// is the whole point of separating the entities: a Darbi invoice must split on
// where Darbi is registered.
export function isIntraState(entity, customer) {
  const norm = s => (s == null ? '' : String(s).trim().toLowerCase());
  const seller = norm(entity?.state);
  const buyer = norm(customer?.state);
  if (!seller || !buyer) return false;
  return seller === buyer;
}

export { withFallback as __withFallback };
