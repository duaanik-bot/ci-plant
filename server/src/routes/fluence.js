// Fluence Prescription & Kit Master — a Fluence-only feature.
//
// Everything here reads and writes the fluence_* tables and never alters an
// existing one. A product is "Fluence" when its customer is in
// fluence_customers; every endpoint that takes a product refuses any other.
//
// The master is the source of truth: Planning, Artwork, the Job Card, the floor
// stations, Dispatch, Invoice, Accounts and Warehouse all READ the same kit
// record live, and a save from any of them writes the master itself — with the
// revision it was based on, so two people editing at once cannot silently
// overwrite each other — and records who changed what, from where.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, notify } from '../helpers.js';
import { requireRole, PLANNING_ROLES } from '../auth.js';
import { notificationRecipients } from '../approvals.js';
import { dossierFor, needsMasters } from '../access.js';
import {
  nameKey, normaliseRxPayload, normaliseComponentsPayload, normaliseDims, FLUENCE_CONTEXTS, rxChangedAfterFinalise,
  rxLinesInStep, componentsSignature, kitChangeSummary,
} from '../../../client/src/lib/fluence.js';

const r = Router();
// The people who decide work — Planning, Artwork, Job Cards — maintain the
// master. Everyone signed in may review it.
const canEditMaster = requireRole(...PLANNING_ROLES);
const canEdit = user => user?.role === 'admin' || PLANNING_ROLES.includes(user?.role);

const fail = (status, message, body) => Object.assign(new Error(message), { status, ...(body ? { body } : {}) });

// A change made from a customer's own login (only the Fluence module ticked —
// access.js) is made at once, signed with the login's ID, and Colour Impressions
// management (Masters → Users: Management) is told in the same transaction:
// what changed, on which kit, and who signed it. Staff changes stay quiet.
export async function tellManagement(user, { kitId = null, subject, change, link = null }, qc) {
  if (!user?.outside) return;
  const users = await qc('SELECT id, active, is_management FROM users');
  await notify(notificationRecipients(users, 'is_management', user.id), {
    kind: 'fluence_change',
    title: `${subject} — changed by ${user.name}`,
    body: `${change}. Signed: ${user.name}.`,
    link: link ?? (kitId ? `/fluence?kit=${kitId}&view=history` : '/fluence'),
    refTable: kitId ? 'fluence_kits' : null,
    refId: kitId,
  }, qc);
}

// A database that has not had the Fluence migration applied answers every read
// with an empty, switched-off feature instead of a 500 — so no button anywhere
// can appear, and no screen can break, before the tables exist.
const MISSING_TABLE = '42P01';
const offWhenMissing = (res, next, empty) => e => (e?.code === MISSING_TABLE ? res.json(empty) : next(e));

const idList = raw => [...new Set(String(raw ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0))];
const contextOf = raw => (FLUENCE_CONTEXTS[raw] ? raw : null);

// ── Scope ────────────────────────────────────────────────────────────────────
// Which customers and products the feature is on for. Small (a few hundred ids)
// and read once per screen, so every row can decide for itself whether to show
// its Fluence button without any existing query carrying a new column.
r.get('/fluence/scope', async (req, res, next) => {
  try {
    const row = await one(`
      SELECT (SELECT COALESCE(json_agg(customer_id ORDER BY customer_id), '[]'::json) FROM fluence_customers) AS customer_ids,
             (SELECT COALESCE(json_agg(p.id ORDER BY p.id), '[]'::json)
                FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id) AS product_ids`);
    res.json({ enabled: true, can_edit: canEdit(req.user), customer_ids: row.customer_ids, product_ids: row.product_ids });
  } catch (e) {
    offWhenMissing(res, next, { enabled: false, can_edit: false, customer_ids: [], product_ids: [] })(e);
  }
});

// ── Which kit a carton reads ─────────────────────────────────────────────────
// Its own kit — or, for a PART carton (a Topico filler, inner box, leaflet,
// tray, separator), the kit of its outer carton. A carton that has a kit of its
// own is never treated as a part. Joins as `pc` / `op` / `k` on products `p`.
const KIT_OF_CARTON = `
    LEFT JOIN fluence_part_cartons pc ON pc.product_id = p.id
          AND NOT EXISTS (SELECT 1 FROM fluence_kits own WHERE own.product_id = p.id)
    LEFT JOIN products op ON op.id = pc.outer_product_id
    LEFT JOIN fluence_kits k ON k.product_id = COALESCE(pc.outer_product_id, p.id)`;

// ── Dossier: everything a Fluence door shows about one product ───────────────
// What a kit holds and says — its items, its prescription and its history —
// for any set of kits, whether or not a product carries them yet.
async function kitRecords(kitIds, qc) {
  const components = kitIds.length ? await qc(`
    SELECT kc.kit_id, kc.id, kc.sr, kc.qty_per_kit, kc.mrp_in_kit, kc.remarks,
           ip.id AS inner_product_id, ip.name, ip.kind, ip.product_code, ip.artwork_code, ip.dosage_form,
           ip.standard_mrp, ip.carton_l, ip.carton_w, ip.carton_h, ip.packaging_info,
           ip.remarks AS inner_remarks, ip.erp_product_id, ep.code AS erp_product_code, ep.size AS erp_size
    FROM fluence_kit_components kc
    JOIN fluence_inner_products ip ON ip.id = kc.inner_product_id
    LEFT JOIN products ep ON ep.id = ip.erp_product_id
    WHERE kc.kit_id = ANY($1::int[])
    ORDER BY kc.kit_id, kc.sr, kc.id`, [kitIds]) : [];

  const rxs = kitIds.length ? await qc(`
    SELECT id, kit_id, general_instructions, remarks, revision, updated_at, updated_by, updated_from
    FROM fluence_prescriptions WHERE kit_id = ANY($1::int[])`, [kitIds]) : [];
  const rxIds = rxs.map(x => x.id);
  const rxLines = rxIds.length ? await qc(`
    SELECT l.*, ip.name AS item_name
    FROM fluence_prescription_lines l
    LEFT JOIN fluence_inner_products ip ON ip.id = l.inner_product_id
    WHERE l.prescription_id = ANY($1::int[])
    ORDER BY l.prescription_id, l.sr, l.id`, [rxIds]) : [];

  const revisions = kitIds.length ? await qc(`
    SELECT id, kit_id, area, revision, note, changed_by, changed_from, changed_at
    FROM fluence_master_revisions WHERE kit_id = ANY($1::int[])
    ORDER BY changed_at DESC, id DESC`, [kitIds]) : [];
  return { components, rxs, rxLines, revisions };
}

async function loadDossiers(productIds, qc = q) {
  if (!productIds.length) return [];
  const products = await qc(`
    SELECT p.id, p.code, p.name, p.party_item_code, p.party_artwork_code, p.internal_carton_code,
           p.mrp, p.size, p.colors, p.colour_type, p.output_number, p.shade_card_number, p.shade_card_date,
           p.board_name, p.gsm, p.child_l, p.child_w, p.ups, p.coating, p.pasting_type, p.die_number, p.active,
           p.customer_id, c.name AS customer_name,
           pc.part, pc.outer_product_id, op.code AS outer_code, op.name AS outer_name, op.mrp AS outer_mrp,
           k.id AS kit_id, k.product_id AS kit_product_id, k.kit_name, k.source_ref, k.link_method, k.linked_at, k.linked_by,
           k.party_sl_no, to_char(k.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(k.valid_to, 'YYYY-MM-DD') AS valid_to,
           k.kit_type, k.kit_total_mrp, k.remarks AS kit_remarks
    FROM products p
    JOIN fluence_customers fc ON fc.customer_id = p.customer_id
    JOIN customers c ON c.id = p.customer_id
    ${KIT_OF_CARTON}
    WHERE p.id = ANY($1::int[])`, [productIds]);
  const kitIds = products.map(p => p.kit_id).filter(Boolean);

  // The part cartons printed for each kit's outer carton.
  const outerIds = [...new Set(products.map(p => p.kit_product_id).filter(Boolean))];
  const parts = outerIds.length ? await qc(`
    SELECT pc.outer_product_id, p.id, p.code, p.name, pc.part
    FROM fluence_part_cartons pc JOIN products p ON p.id = pc.product_id
    WHERE pc.outer_product_id = ANY($1::int[])
      AND NOT EXISTS (SELECT 1 FROM fluence_kits own WHERE own.product_id = pc.product_id)
    ORDER BY pc.outer_product_id, p.code, p.id`, [outerIds]) : [];

  const { components, rxs, rxLines, revisions } = await kitRecords(kitIds, qc);

  const byId = new Map(products.map(p => [p.id, p]));
  return productIds.filter(id => byId.has(id)).map(id => {
    const p = byId.get(id);
    const rx = rxs.find(x => x.kit_id === p.kit_id) || null;
    return {
      product: {
        id: p.id, code: p.code, name: p.name, party_item_code: p.party_item_code,
        party_artwork_code: p.party_artwork_code, internal_carton_code: p.internal_carton_code,
        mrp: p.mrp, size: p.size, colors: p.colors, colour_type: p.colour_type,
        output_number: p.output_number, shade_card_number: p.shade_card_number, shade_card_date: p.shade_card_date,
        board_name: p.board_name, gsm: p.gsm, child_l: p.child_l, child_w: p.child_w, ups: p.ups,
        coating: p.coating, pasting_type: p.pasting_type, die_number: p.die_number, active: p.active,
        customer_id: p.customer_id, customer_name: p.customer_name,
      },
      // Set when this carton is a part: the outer carton whose kit it shows.
      part_of: p.outer_product_id ? {
        outer_product_id: p.outer_product_id, outer_code: p.outer_code, outer_name: p.outer_name,
        outer_mrp: p.outer_mrp, part: p.part,
      } : null,
      kit: p.kit_id ? {
        id: p.kit_id, product_id: p.kit_product_id, kit_name: p.kit_name, source_ref: p.source_ref,
        from_customer_list: String(p.source_ref || '').startsWith('customer-master:'),
        link_method: p.link_method, linked_at: p.linked_at, linked_by: p.linked_by,
        party_sl_no: p.party_sl_no, valid_from: p.valid_from, valid_to: p.valid_to,
        kit_type: p.kit_type, kit_total_mrp: p.kit_total_mrp, remarks: p.kit_remarks,
        parts: parts.filter(x => x.outer_product_id === p.kit_product_id)
          .map(x => ({ product_id: x.id, code: x.code, name: x.name, part: x.part })),
      } : null,
      components: components.filter(c => c.kit_id === p.kit_id),
      prescription: rx ? { ...rx, lines: rxLines.filter(l => l.prescription_id === rx.id) } : null,
      revisions: revisions.filter(v => v.kit_id === p.kit_id).slice(0, 20),
    };
  });
}

// The same dossier found by the kit's own id — a kit designed in Kit Studio has
// no product until its carton goes into the product master. A linked kit IS its
// product's dossier; an unlinked one carries no product.
async function loadKitDossier(kitId, qc = q) {
  const kit = (await qc(`
    SELECT k.id, k.product_id, k.kit_name, k.source_ref, k.link_method, k.linked_at, k.linked_by, k.party_sl_no,
           to_char(k.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(k.valid_to, 'YYYY-MM-DD') AS valid_to,
           k.kit_type, k.kit_total_mrp, k.remarks, k.superseded_by_kit_id
    FROM fluence_kits k WHERE k.id = $1`, [kitId]))[0];
  if (!kit) return null;
  if (kit.product_id) {
    const [d] = await loadDossiers([kit.product_id], qc);
    if (d && d.kit?.id === kit.id) return d;
  }
  const { components, rxs, rxLines, revisions } = await kitRecords([kit.id], qc);
  const rx = rxs[0] || null;
  return {
    product: null,
    part_of: null,
    kit: { ...kit, from_customer_list: String(kit.source_ref || '').startsWith('customer-master:'), parts: [] },
    components,
    prescription: rx ? { ...rx, lines: rxLines } : null,
    revisions: revisions.slice(0, 20),
  };
}

r.get('/fluence/kits/:id/dossier', async (req, res, next) => {
  try {
    const kitId = Number(req.params.id);
    if (!(Number.isInteger(kitId) && kitId > 0)) throw fail(400, 'Not a valid kit.');
    const dossier = await loadKitDossier(kitId);
    if (!dossier) throw fail(404, 'This kit is no longer in the Fluence master — reload the page.');
    res.json({ can_edit: canEdit(req.user), dossier: dossierFor(dossier, req.access) });
  } catch (e) {
    offWhenMissing(res, next, { can_edit: false, dossier: null })(e);
  }
});

r.get('/fluence/dossiers', async (req, res, next) => {
  try {
    const ids = idList(req.query.product_ids);
    const dossiers = await loadDossiers(ids);
    res.json({ can_edit: canEdit(req.user), dossiers: dossiers.map(d => dossierFor(d, req.access)), not_fluence: ids.filter(id => !dossiers.some(d => d.product.id === id)) });
  } catch (e) {
    offWhenMissing(res, next, { can_edit: false, dossiers: [], not_fluence: [] })(e);
  }
});

// ── Resolve: which Fluence products does this record carry? ──────────────────
// For the doors whose row names a document rather than a product — an invoice,
// a challan, a gang, a job card. Order follows the document's own line order.
const RESOLVERS = {
  job_card_id: `
    SELECT DISTINCT ON (x.product_id) x.product_id, x.ord FROM (
      SELECT ol.product_id, ol.id AS ord
      FROM job_cards jc JOIN order_lines ol ON ol.gang_run_id = jc.gang_run_id
      WHERE jc.id = $1 AND jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL
      UNION ALL
      SELECT jc.product_id, 0 AS ord FROM job_cards jc
      WHERE jc.id = $1 AND NOT (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL)
    ) x ORDER BY x.product_id, x.ord`,
  gang_run_id: `
    SELECT DISTINCT ON (ol.product_id) ol.product_id, ol.id AS ord
    FROM order_lines ol WHERE ol.gang_run_id = $1 ORDER BY ol.product_id, ol.id`,
  order_line_id: `SELECT ol.product_id, ol.id AS ord FROM order_lines ol WHERE ol.id = $1`,
  invoice_id: `
    SELECT DISTINCT ON (il.product_id) il.product_id, il.id AS ord
    FROM invoice_lines il WHERE il.invoice_id = $1 ORDER BY il.product_id, il.id`,
  dispatch_id: `
    SELECT DISTINCT ON (dl.product_id) dl.product_id, dl.id AS ord
    FROM dispatch_lines dl WHERE dl.dispatch_id = $1 ORDER BY dl.product_id, dl.id`,
};

export async function resolveFluenceProducts(kind, id, qc = q) {
  const sql = RESOLVERS[kind];
  if (!sql) return [];
  const rows = await qc(`
    SELECT r.product_id FROM (${sql}) r
    JOIN products p ON p.id = r.product_id
    JOIN fluence_customers fc ON fc.customer_id = p.customer_id
    ORDER BY r.ord, r.product_id`, [id]);
  return rows.map(x => x.product_id);
}

r.get('/fluence/resolve', async (req, res, next) => {
  try {
    const kind = Object.keys(RESOLVERS).find(k => req.query[k] != null);
    const id = Number(req.query[kind]);
    if (!kind || !(Number.isInteger(id) && id > 0)) throw fail(400, `Pass one of ${Object.keys(RESOLVERS).join(', ')}`);
    res.json({ product_ids: await resolveFluenceProducts(kind, id) });
  } catch (e) {
    offWhenMissing(res, next, { product_ids: [] })(e);
  }
});

// ── Which Fluence products each job card carries ─────────────────────────────
// For boards whose cards name only a LEAD product (Print Planning): a gang or
// combined-run card carries every member line's carton, and a mixed run can lead
// with another customer's product. One batched call answers a whole board, in
// the run's own line order, so the Fluence door can open product-wise.
r.get('/fluence/job-cards/products', async (req, res, next) => {
  try {
    const ids = idList(req.query.ids).slice(0, 200);
    const products = {};
    if (ids.length) {
      const rows = await q(`
        SELECT x.job_card_id, x.product_id FROM (
          SELECT jc.id AS job_card_id, ol.product_id, MIN(ol.id) AS ord
          FROM job_cards jc
          JOIN order_lines ol ON (jc.order_line_id IS NOT NULL AND ol.id = jc.order_line_id)
                              OR (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL AND ol.gang_run_id = jc.gang_run_id)
          JOIN products p ON p.id = ol.product_id
          JOIN fluence_customers fc ON fc.customer_id = p.customer_id
          WHERE jc.id = ANY($1::int[])
          GROUP BY jc.id, ol.product_id
        ) x
        ORDER BY x.job_card_id, x.ord, x.product_id`, [ids]);
      for (const id of ids) products[id] = [];
      for (const row of rows) products[row.job_card_id].push(row.product_id);
    }
    res.json({ products });
  } catch (e) {
    offWhenMissing(res, next, { products: {} })(e);
  }
});

// ── Job card prescriptions — what the printed card's Fluence page shows ──────
// Product-wise, always: a gang job card lists each of its Fluence cartons with
// that carton's own prescription and artwork code. Never merged into one.
r.get('/fluence/job-cards/prescriptions', async (req, res, next) => {
  try {
    const ids = idList(req.query.ids).slice(0, 200);
    const cards = {};
    if (ids.length) {
      const jcs = await q(`
        SELECT jc.id, jc.jc_number, jc.finalised_at, jc.order_line_id, jc.gang_run_id, gg.gang_number, gg.kind AS run_kind
        FROM job_cards jc LEFT JOIN gang_runs gg ON gg.id = jc.gang_run_id
        WHERE jc.id = ANY($1::int[])`, [ids]);
      // Every line the card carries — its own, or every member of its gang/run —
      // with the artwork code as the job actually prints it (a job override wins).
      const lines = await q(`
        SELECT jc.id AS job_card_id, ol.id AS line_id, ol.product_id, ol.qty, o.po_number,
               COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code
        FROM job_cards jc
        JOIN order_lines ol ON (jc.order_line_id IS NOT NULL AND ol.id = jc.order_line_id)
                            OR (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL AND ol.gang_run_id = jc.gang_run_id)
        JOIN orders o ON o.id = ol.order_id
        JOIN products p ON p.id = ol.product_id
        JOIN fluence_customers fc ON fc.customer_id = p.customer_id
        WHERE jc.id = ANY($1::int[])
        ORDER BY jc.id, ol.id`, [ids]);
      const dossiers = await loadDossiers([...new Set(lines.map(l => l.product_id))]);
      const dossierOf = new Map(dossiers.map(d => [d.product.id, d]));
      for (const jc of jcs) {
        const own = lines.filter(l => l.job_card_id === jc.id);
        const items = [];
        for (const l of own) {
          const existing = items.find(i => i.product_id === l.product_id);
          if (existing) { existing.po_numbers.push(l.po_number); existing.qty += +l.qty || 0; continue; }
          const d = dossierOf.get(l.product_id);
          if (!d) continue;
          const rx = d.prescription;
          items.push({
            product_id: l.product_id, line_id: l.line_id,
            product_code: d.product.code, product_name: d.product.name,
            party_item_code: d.product.party_item_code,
            party_artwork_code: l.party_artwork_code,
            qty: +l.qty || 0, po_numbers: [l.po_number],
            kit_name: d.kit?.kit_name ?? null,
            part_of: d.part_of,
            components: d.components.map(c => ({ name: c.name, qty_per_kit: c.qty_per_kit })),
            prescription: rx,
            // Only a person's save after finalising warns — never the customer master's list.
            rx_changed_after_finalise: rxChangedAfterFinalise(rx, jc.finalised_at),
          });
        }
        if (items.length) cards[jc.id] = { id: jc.id, jc_number: jc.jc_number, finalised_at: jc.finalised_at, gang_number: jc.gang_number, run_kind: jc.run_kind, items };
      }
    }
    res.json({ cards });
  } catch (e) {
    offWhenMissing(res, next, { cards: {} })(e);
  }
});

// ── Writes ───────────────────────────────────────────────────────────────────
async function fluenceProduct(productId, oc) {
  // No lock on the product row: the product master belongs to other screens,
  // and serialising two saves is the kit row's job (kitForProduct locks it).
  const p = await oc(`
    SELECT p.id, p.code, p.name FROM products p
    JOIN fluence_customers fc ON fc.customer_id = p.customer_id
    WHERE p.id = $1`, [productId]);
  if (!p) throw fail(404, 'Not a Fluence product — the prescription & kit master is for Fluence products only.');
  return p;
}

// The outer carton a part carton belongs to (null for every other carton, and
// for a carton that has a kit of its own).
const outerCartonOf = (productId, oc) => oc(`
  SELECT op.id, op.code, op.name, pc.part FROM fluence_part_cartons pc
  JOIN products op ON op.id = pc.outer_product_id
  WHERE pc.product_id = $1 AND NOT EXISTS (SELECT 1 FROM fluence_kits own WHERE own.product_id = $1)`, [productId]);

// The kit a carton READS right now, if any — no lock, never creates one.
const kitIdOf = async (productId, oc) => (await oc(`
  SELECT k.id FROM products p ${KIT_OF_CARTON} WHERE p.id = $1 AND k.id IS NOT NULL`, [productId]))?.id ?? null;

// The kit a product's master hangs off: its own, or — for a part carton — its
// outer carton's, so an edit made from a part changes that one kit. A Fluence
// product with neither gets its own the first time someone records something
// for it; a part whose outer carton has none starts it on the OUTER carton.
async function kitForProduct(product, user, qc, oc) {
  const own = await oc('SELECT * FROM fluence_kits WHERE product_id = $1 FOR UPDATE', [product.id]);
  if (own) return { kit: own, outer: null };
  const outer = await outerCartonOf(product.id, oc);
  if (outer) {
    const theirs = await oc('SELECT * FROM fluence_kits WHERE product_id = $1 FOR UPDATE', [outer.id]);
    if (theirs) return { kit: theirs, outer };
  }
  const carton = outer || product;
  const kit = await oc(`
    INSERT INTO fluence_kits (kit_name, source_ref, product_id, link_method, linked_at, linked_by, created_by, updated_by)
    VALUES ($1, $2, $3, 'created_from_product', now(), $4, $4, $4)
    ON CONFLICT (source_ref) DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now()
    RETURNING *`, [carton.name, `erp-product:${carton.id}`, carton.id, user.name]);
  return { kit, outer };
}

// Said on the revision and the audit line when the save came from a part.
const fromPart = (product, outer) => (outer ? `Saved from part carton ${product.code} ${product.name} (${outer.part}) — the kit of its outer carton ${outer.code}` : null);

const rxSnapshot = async (kitId, qc) => {
  const rx = (await qc('SELECT general_instructions, remarks, revision FROM fluence_prescriptions WHERE kit_id = $1', [kitId]))[0];
  if (!rx) return null;
  const lines = await qc(`
    SELECT l.sr, l.inner_product_id, ip.name AS item_name, l.item_label, l.dosage, l.dose_form, l.pack_count, l.frequency,
           l.morning_qty, l.afternoon_qty, l.evening_qty, l.night_qty, l.other_timing, l.other_qty, l.instructions, l.remarks
    FROM fluence_prescription_lines l
    JOIN fluence_prescriptions p ON p.id = l.prescription_id
    LEFT JOIN fluence_inner_products ip ON ip.id = l.inner_product_id
    WHERE p.kit_id = $1 ORDER BY l.sr, l.id`, [kitId]);
  return { general_instructions: rx.general_instructions, remarks: rx.remarks, revision: rx.revision, lines };
};

const componentsSnapshot = (kitId, qc) => qc(`
  SELECT kc.sr, kc.inner_product_id, ip.name, kc.qty_per_kit, kc.mrp_in_kit, kc.remarks
  FROM fluence_kit_components kc JOIN fluence_inner_products ip ON ip.id = kc.inner_product_id
  WHERE kc.kit_id = $1 ORDER BY kc.sr, kc.id`, [kitId]);

// Content only — a save that changes nothing must not mint a revision. Lines
// are compared field by field in ONE fixed order, so a stored row and a payload
// that list their keys differently still compare equal.
const RX_LINE_FIELDS = ['sr', 'inner_product_id', 'item_label', 'dosage', 'dose_form', 'pack_count', 'frequency',
  'morning_qty', 'afternoon_qty', 'evening_qty', 'night_qty', 'other_timing', 'other_qty', 'instructions', 'remarks'];
const rxContent = s => JSON.stringify({
  g: s?.general_instructions ?? null,
  r: s?.remarks ?? null,
  l: (s?.lines || []).map(l => RX_LINE_FIELDS.map(k => (l[k] == null ? null : (typeof l[k] === 'number' ? +l[k] : l[k])))),
});
export const sameRx = (a, b) => rxContent(a) === rxContent(b);

async function assertInnerProducts(ids, qc) {
  const want = [...new Set(ids.filter(v => v != null))];
  if (!want.length) return;
  const found = await qc('SELECT id FROM fluence_inner_products WHERE id = ANY($1::int[])', [want]);
  if (found.length !== want.length) throw fail(400, 'One of the chosen kit items no longer exists in the inner product master — reload and pick again.');
}

async function recordRevision({ kitId, area, revision = null, before, after, note = null, user, from }, qc) {
  await qc(`
    INSERT INTO fluence_master_revisions (kit_id, area, revision, before, after, note, changed_by, changed_by_id, changed_from)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
  [kitId, area, revision, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note, user.name, user.id ?? null, from]);
}

// A prescription written as `value` says, at `revision`: the header row, and its
// lines replaced whole.
async function writeRx(kitId, value, revision, user, from, qc, oc) {
  const rx = await oc(`
    INSERT INTO fluence_prescriptions (kit_id, general_instructions, remarks, revision, updated_at, updated_by, updated_from)
    VALUES ($1, $2, $3, $4, now(), $5, $6)
    ON CONFLICT (kit_id) DO UPDATE SET
      general_instructions = EXCLUDED.general_instructions, remarks = EXCLUDED.remarks,
      revision = EXCLUDED.revision, updated_at = now(), updated_by = EXCLUDED.updated_by, updated_from = EXCLUDED.updated_from
    RETURNING *`, [kitId, value.general_instructions, value.remarks, revision, user.name, from]);
  await qc('DELETE FROM fluence_prescription_lines WHERE prescription_id = $1', [rx.id]);
  for (const l of value.lines) {
    await qc(`
      INSERT INTO fluence_prescription_lines
        (prescription_id, sr, inner_product_id, item_label, dosage, dose_form, pack_count, frequency,
         morning_qty, afternoon_qty, evening_qty, night_qty, other_timing, other_qty, instructions, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [rx.id, l.sr, l.inner_product_id, l.item_label, l.dosage, l.dose_form, l.pack_count, l.frequency,
      l.morning_qty, l.afternoon_qty, l.evening_qty, l.night_qty, l.other_timing, l.other_qty, l.instructions, l.remarks]);
  }
  return rx;
}

// A kit list written whole, in order.
async function writeKitComponents(kitId, components, user, qc) {
  await qc('DELETE FROM fluence_kit_components WHERE kit_id = $1', [kitId]);
  for (const c of components) {
    await qc(`
      INSERT INTO fluence_kit_components (kit_id, inner_product_id, sr, qty_per_kit, mrp_in_kit, remarks, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [kitId, c.inner_product_id, c.sr, c.qty_per_kit, c.mrp_in_kit, c.remarks, user.name]);
  }
}

// After a kit list was written on its own (Kit Studio's Push to Kits, the old
// kit-list editor), the prescription follows it: a bare line for each new item,
// the lines of an item that left the box removed. A revision says what moved.
// Nothing happens when the two already agree. Exported for Kit Studio.
export async function keepRxInStep(kitId, user, from, qc, oc) {
  const comps = await componentsSnapshot(kitId, qc);
  const current = await oc('SELECT * FROM fluence_prescriptions WHERE kit_id = $1 FOR UPDATE', [kitId]);
  const before = current ? await rxSnapshot(kitId, qc) : null;
  if (!before && !comps.length) return null;
  const step = rxLinesInStep(comps, before?.lines || []);
  if (before && !step.added.length && !step.removed.length) return null;
  const revision = (current?.revision ?? 0) + 1;
  await writeRx(kitId, { general_instructions: before?.general_instructions ?? null, remarks: before?.remarks ?? null, lines: step.lines },
    revision, user, from, qc, oc);
  const after = await rxSnapshot(kitId, qc);
  const nameOf = id => comps.find(c => c.inner_product_id === id)?.name ?? `item ${id}`;
  const note = ['Kept in step with the kit list',
    step.added.length ? `added ${step.added.map(l => nameOf(l.inner_product_id)).join(', ')}` : null,
    step.removed.length ? `removed ${step.removed.map(l => l.item_name || `item ${l.inner_product_id}`).join(', ')}` : null,
  ].filter(Boolean).join(' — ');
  await recordRevision({ kitId, area: 'prescription', revision, before, after, note, user, from }, qc);
  await audit('fluence_kit', kitId, `prescription_revised:rev ${revision}`, note, qc, user.name);
  return { revision };
}

// ── Kit contents and prescription, in one save ───────────────────────────────
// What is in the box and how each item is taken are edited together and saved
// in ONE transaction; each keeps its own revision, minted only when it changed.
// A line names an item in the box or says what it is for; every item in the box
// keeps at least one line, so a job card can never print a kit list and a
// prescription that disagree. Both halves carry what the editor opened
// (base_components, base_revision): a colleague's save in between is refused,
// never overwritten.
async function saveKitAndRx({ kit, product, outer, body, user, from }, qc, oc) {
  const comps = normaliseComponentsPayload(body);
  const rx = normaliseRxPayload(body);
  const errors = [...comps.errors, ...rx.errors];
  const components = comps.value.components;
  const inKit = new Set(components.map(c => c.inner_product_id));
  rx.value.lines.forEach((l, i) => {
    if (l.inner_product_id != null && !inKit.has(l.inner_product_id)) {
      errors.push(`Line ${i + 1}: that item is not in the kit — add it to the kit, or type what the line is for.`);
    }
  });
  if (errors.length) throw fail(400, errors.join(' '));
  await assertInnerProducts(components.map(c => c.inner_product_id), qc);
  const value = {
    general_instructions: rx.value.general_instructions,
    remarks: rx.value.remarks,
    lines: rxLinesInStep(components, rx.value.lines).lines,
  };

  const beforeComps = await componentsSnapshot(kit.id, qc);
  if (body?.base_components != null && String(body.base_components) !== componentsSignature(beforeComps)) {
    throw fail(409, 'The kit list was changed by someone else after you opened it. '
      + 'Your edits were not saved — reopen it to see the latest, then make your change again.');
  }
  const current = await oc('SELECT * FROM fluence_prescriptions WHERE kit_id = $1 FOR UPDATE', [kit.id]);
  const currentRev = current?.revision ?? 0;
  if (body?.base_revision != null && Number(body.base_revision) !== currentRev) {
    throw fail(409,
      `This prescription was changed by ${current?.updated_by || 'someone else'} (now revision ${currentRev}) after you opened it. `
      + 'Your edits were not saved — reopen it to see the latest, then make your change again.');
  }
  const label = product ? `${product.code} ${product.name}${outer ? ` (part carton of ${outer.code})` : ''}` : kit.kit_name;
  const note = product ? fromPart(product, outer) : null;

  let componentsChanged = false;
  if (componentsSignature(beforeComps) !== componentsSignature(components)) {
    await writeKitComponents(kit.id, components, user, qc);
    const after = await componentsSnapshot(kit.id, qc);
    await recordRevision({ kitId: kit.id, area: 'components', before: beforeComps, after, note, user, from }, qc);
    await audit('fluence_kit', kit.id, 'kit_components_updated',
      `${label} — ${after.length} inner product(s), saved with the prescription from ${FLUENCE_CONTEXTS[from]}`, qc, user.name);
    componentsChanged = true;
  }

  const beforeRx = current ? await rxSnapshot(kit.id, qc) : null;
  const nothing = !value.lines.length && !value.general_instructions && !value.remarks;
  let rxChanged = false;
  let revision = currentRev;
  if (!(nothing && !current) && !(beforeRx && sameRx(beforeRx, value))) {
    revision = currentRev + 1;
    await writeRx(kit.id, value, revision, user, from, qc, oc);
    const after = await rxSnapshot(kit.id, qc);
    await recordRevision({ kitId: kit.id, area: 'prescription', revision, before: beforeRx, after, note, user, from }, qc);
    await audit('fluence_kit', kit.id, `prescription_revised:rev ${revision}`,
      `${label} — prescription revision ${revision}, ${value.lines.length} line(s), saved with the kit list from ${FLUENCE_CONTEXTS[from]}`,
      qc, user.name);
    rxChanged = true;
  }
  if (user.outside && (componentsChanged || rxChanged)) {
    const afterComps = componentsChanged ? await componentsSnapshot(kit.id, qc) : beforeComps;
    const afterRx = rxChanged ? await rxSnapshot(kit.id, qc) : beforeRx;
    const change = kitChangeSummary({ components: beforeComps, rx: beforeRx }, { components: afterComps, rx: afterRx });
    await tellManagement(user, { kitId: kit.id, subject: label, change: rxChanged ? `${change} (prescription revision ${revision})` : change }, qc);
  }
  return { unchanged: !componentsChanged && !rxChanged, componentsChanged, rxChanged, revision };
}

// The one editor's save — contents and prescription together. By product (the
// Fluence door in any module) …
r.put('/fluence/products/:productId/kit', canEditMaster, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const from = contextOf(req.body?.from) || 'fluence_master';
    const outcome = await tx(async (qc, oc) => {
      const product = await fluenceProduct(productId, oc);
      const b = req.body || {};
      const empty = !(b.components || []).length && !(b.lines || []).length && !String(b.general_instructions ?? '').trim() && !String(b.remarks ?? '').trim();
      if (empty && !(await kitIdOf(product.id, oc))) return { unchanged: true, revision: 0 };
      const { kit, outer } = await kitForProduct(product, req.user, qc, oc);
      return saveKitAndRx({ kit, product, outer, body: req.body, user: req.user, from }, qc, oc);
    });
    const [dossier] = await loadDossiers([productId]);
    res.json({ ...outcome, dossier: dossierFor(dossier, req.access) });
  } catch (e) { next(e); }
});

// … or by kit, for a kit that has no product yet (designed in Kit Studio).
r.put('/fluence/kits/:id/kit', canEditMaster, async (req, res, next) => {
  try {
    const kitId = Number(req.params.id);
    if (!(Number.isInteger(kitId) && kitId > 0)) throw fail(400, 'Not a valid kit.');
    const from = contextOf(req.body?.from) || 'fluence_master';
    const outcome = await tx(async (qc, oc) => {
      const kit = await oc('SELECT * FROM fluence_kits WHERE id = $1 FOR UPDATE', [kitId]);
      if (!kit) throw fail(404, 'This kit is no longer in the Fluence master — reload the page.');
      const product = kit.product_id ? await oc('SELECT id, code, name FROM products WHERE id = $1', [kit.product_id]) : null;
      return saveKitAndRx({ kit, product, outer: null, body: req.body, user: req.user, from }, qc, oc);
    });
    res.json({ ...outcome, dossier: dossierFor(await loadKitDossier(kitId), req.access) });
  } catch (e) { next(e); }
});

r.put('/fluence/products/:productId/prescription', canEditMaster, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const from = contextOf(req.body?.from) || 'fluence_master';
    const { errors, value } = normaliseRxPayload(req.body);
    if (errors.length) throw fail(400, errors.join(' '));
    const outcome = await tx(async (qc, oc) => {
      const product = await fluenceProduct(productId, oc);
      const nothingTyped = !value.lines.length && !value.general_instructions && !value.remarks;
      if (nothingTyped && !(await kitIdOf(product.id, oc))) return { unchanged: true, revision: 0 };
      const { kit, outer } = await kitForProduct(product, req.user, qc, oc);
      await assertInnerProducts(value.lines.map(l => l.inner_product_id), qc);
      const current = await oc('SELECT * FROM fluence_prescriptions WHERE kit_id = $1 FOR UPDATE', [kit.id]);
      if (nothingTyped && !current) return { unchanged: true, revision: 0 };
      const currentRev = current?.revision ?? 0;
      const base = req.body?.base_revision;
      if (base != null && Number(base) !== currentRev) {
        throw fail(409,
          `This prescription was changed by ${current?.updated_by || 'someone else'} (now revision ${currentRev}) after you opened it. ` +
          'Your edits were not saved — reopen it to see the latest, then make your change again.');
      }
      const before = await rxSnapshot(kit.id, qc);
      if (before && sameRx(before, value)) return { unchanged: true, revision: currentRev };

      const revision = currentRev + 1;
      await writeRx(kit.id, value, revision, req.user, from, qc, oc);
      const after = await rxSnapshot(kit.id, qc);
      await recordRevision({ kitId: kit.id, area: 'prescription', revision, before, after, note: fromPart(product, outer), user: req.user, from }, qc);
      await audit('fluence_kit', kit.id, `prescription_revised:rev ${revision}`,
        `${product.code} ${product.name}${outer ? ` (part carton of ${outer.code})` : ''} — prescription revision ${revision}, ${value.lines.length} line(s), saved from ${FLUENCE_CONTEXTS[from]}`, qc, req.user.name);
      const comps = await componentsSnapshot(kit.id, qc);
      await tellManagement(req.user, {
        kitId: kit.id, subject: `${product.code} ${product.name}`,
        change: `${kitChangeSummary({ components: comps, rx: before }, { components: comps, rx: after })} (prescription revision ${revision})`,
      }, qc);
      return { unchanged: false, revision };
    });
    const [dossier] = await loadDossiers([productId]);
    res.json({ ...outcome, dossier: dossierFor(dossier, req.access) });
  } catch (e) { next(e); }
});

r.put('/fluence/products/:productId/components', canEditMaster, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const from = contextOf(req.body?.from) || 'fluence_master';
    const { errors, value } = normaliseComponentsPayload(req.body);
    if (errors.length) throw fail(400, errors.join(' '));
    const outcome = await tx(async (qc, oc) => {
      const product = await fluenceProduct(productId, oc);
      if (!value.components.length && !(await kitIdOf(product.id, oc))) return { unchanged: true };
      const { kit, outer } = await kitForProduct(product, req.user, qc, oc);
      await assertInnerProducts(value.components.map(c => c.inner_product_id), qc);
      const before = await componentsSnapshot(kit.id, qc);
      const norm = list => JSON.stringify(list.map(c => [c.inner_product_id, +c.qty_per_kit, c.mrp_in_kit == null ? null : +c.mrp_in_kit, c.remarks ?? null]));
      if (norm(before) === norm(value.components)) return { unchanged: true };
      await writeKitComponents(kit.id, value.components, req.user, qc);
      const after = await componentsSnapshot(kit.id, qc);
      await recordRevision({ kitId: kit.id, area: 'components', before, after, note: fromPart(product, outer), user: req.user, from }, qc);
      await audit('fluence_kit', kit.id, 'kit_components_updated',
        `${product.code} ${product.name}${outer ? ` (part carton of ${outer.code})` : ''} — ${after.length} inner product(s), saved from ${FLUENCE_CONTEXTS[from]}`, qc, req.user.name);
      await keepRxInStep(kit.id, req.user, from, qc, oc);
      await tellManagement(req.user, { kitId: kit.id, subject: `${product.code} ${product.name}`, change: kitChangeSummary({ components: before }, { components: after }) }, qc);
      return { unchanged: false };
    });
    const [dossier] = await loadDossiers([productId]);
    res.json({ ...outcome, dossier: dossierFor(dossier, req.access) });
  } catch (e) { next(e); }
});

// ── Inner product master ─────────────────────────────────────────────────────
const INNER_FIELDS = ['name', 'kind', 'product_code', 'artwork_code', 'dosage_form', 'standard_mrp', 'packaging_info', 'remarks', 'active'];

r.get('/fluence/inner-products', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT ip.*, ep.code AS erp_product_code, ep.name AS erp_product_name, ep.size AS erp_size,
             COALESCE(u.kits, 0) AS kits_count
      FROM fluence_inner_products ip
      LEFT JOIN products ep ON ep.id = ip.erp_product_id
      LEFT JOIN (SELECT inner_product_id, COUNT(*)::int AS kits FROM fluence_kit_components GROUP BY inner_product_id) u
        ON u.inner_product_id = ip.id
      ORDER BY ip.name, ip.id`));
  } catch (e) {
    offWhenMissing(res, next, [])(e);
  }
});

function innerPayload(body, { partial }) {
  const errors = [];
  const out = {};
  for (const f of INNER_FIELDS) if (!partial || f in (body || {})) out[f] = body?.[f];
  if ('name' in out || !partial) {
    out.name = String(out.name ?? '').trim();
    if (!out.name) errors.push('The inner product needs a name.');
  }
  if ('kind' in out) {
    out.kind = out.kind || 'item';
    if (!['item', 'packaging'].includes(out.kind)) errors.push('Kind must be item or packaging.');
  }
  for (const f of ['product_code', 'artwork_code', 'dosage_form', 'packaging_info', 'remarks']) {
    if (f in out) out[f] = out[f] == null || String(out[f]).trim() === '' ? null : String(out[f]).trim().slice(0, 500);
  }
  if ('standard_mrp' in out) {
    const v = out.standard_mrp === '' || out.standard_mrp == null ? null : Number(out.standard_mrp);
    if (v != null && !(Number.isFinite(v) && v >= 0)) errors.push('The standard MRP must be a number, zero or more.');
    out.standard_mrp = Number.isFinite(v) ? v : null;
  }
  if ('active' in out) out.active = +out.active ? 1 : 0;
  const hasDims = ['carton_l', 'carton_w', 'carton_h'].some(k => k in (body || {}));
  if (!partial || hasDims) {
    const dims = normaliseDims(body);
    errors.push(...dims.errors);
    Object.assign(out, dims.value);
  }
  if ('erp_product_id' in (body || {})) {
    const v = body.erp_product_id === '' || body.erp_product_id == null ? null : Number(body.erp_product_id);
    if (v != null && !(Number.isInteger(v) && v > 0)) errors.push('The linked ERP product is not valid.');
    out.erp_product_id = v;
  }
  return { errors, value: out };
}

async function assertErpProduct(id, oc) {
  if (id == null) return;
  const p = await oc('SELECT p.id FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id WHERE p.id = $1', [id]);
  if (!p) throw fail(400, 'A printed packaging component can only link to a Fluence product.');
}

r.post('/fluence/inner-products', canEditMaster, async (req, res, next) => {
  try {
    const { errors, value } = innerPayload(req.body, { partial: false });
    if (errors.length) throw fail(400, errors.join(' '));
    const row = await tx(async (qc, oc) => {
      const clash = await oc('SELECT id, name FROM fluence_inner_products WHERE name_key = $1', [nameKey(value.name)]);
      if (clash) throw fail(409, `"${clash.name}" is already in the inner product master — use that one.`);
      await assertErpProduct(value.erp_product_id ?? null, oc);
      const created = await oc(`
        INSERT INTO fluence_inner_products
          (name, name_key, kind, product_code, artwork_code, erp_product_id, dosage_form, standard_mrp,
           carton_l, carton_w, carton_h, packaging_info, remarks, active, source, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,1),'manual',$15,$15)
        RETURNING *`,
      [value.name, nameKey(value.name), value.kind || 'item', value.product_code ?? null, value.artwork_code ?? null,
        value.erp_product_id ?? null, value.dosage_form ?? null, value.standard_mrp ?? null,
        value.carton_l, value.carton_w, value.carton_h, value.packaging_info ?? null, value.remarks ?? null,
        value.active ?? null, req.user.name]);
      await audit('fluence_inner_product', created.id, 'create', created.name, qc, req.user.name);
      await tellManagement(req.user, { subject: `Inner product ${created.name}`, change: 'added to the inner product master', link: '/fluence?tab=inner' }, qc);
      return created;
    });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

r.put('/fluence/inner-products/:id', canEditMaster, async (req, res, next) => {
  try {
    const { errors, value } = innerPayload(req.body, { partial: true });
    if (errors.length) throw fail(400, errors.join(' '));
    const row = await tx(async (qc, oc) => {
      const before = await oc('SELECT * FROM fluence_inner_products WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) throw fail(404, 'Inner product not found.');
      if ('name' in value) {
        const clash = await oc('SELECT id, name FROM fluence_inner_products WHERE name_key = $1 AND id <> $2', [nameKey(value.name), before.id]);
        if (clash) throw fail(409, `"${clash.name}" is already in the inner product master.`);
        value.name_key = nameKey(value.name);
      }
      if ('erp_product_id' in value) await assertErpProduct(value.erp_product_id, oc);
      const keys = Object.keys(value);
      if (!keys.length) return before;
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const updated = await oc(
        `UPDATE fluence_inner_products SET ${sets}, updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1 RETURNING *`,
        [before.id, ...keys.map(k => value[k]), req.user.name]);
      const changed = keys.filter(k => String(before[k] ?? '') !== String(updated[k] ?? ''));
      if (changed.length) {
        const what = changed.map(k => `${k}: ${before[k] ?? '—'} → ${updated[k] ?? '—'}`).join('; ');
        await audit('fluence_inner_product', before.id, 'update', what.slice(0, 1000), qc, req.user.name);
        await tellManagement(req.user, { subject: `Inner product ${updated.name}`, change: what.slice(0, 480), link: '/fluence?tab=inner' }, qc);
      }
      return updated;
    });
    res.json(row);
  } catch (e) { next(e); }
});

// ── The master lists (Fluence Master page) ───────────────────────────────────
r.get('/fluence/products', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT p.id, p.code, p.name, p.party_item_code, p.party_artwork_code, p.mrp, p.size, p.active,
             k.id AS kit_id, k.kit_name, k.link_method, k.source_ref,
             pc.part, op.code AS outer_code,
             COALESCE(kc.n, 0) AS components_count,
             rx.revision AS rx_revision, rx.updated_at AS rx_updated_at, rx.updated_by AS rx_updated_by,
             rx.updated_from AS rx_updated_from, COALESCE(rl.n, 0) AS rx_lines,
             -- rxState() in SQL: 'full' when something is prescribed (a line with a
             -- dose, or general instructions), 'items' when only the kit's products are listed.
             CASE WHEN rx.id IS NULL THEN 'none'
                  WHEN COALESCE(rl.dosed, 0) > 0 OR NULLIF(btrim(rx.general_instructions), '') IS NOT NULL THEN 'full'
                  WHEN COALESCE(rl.n, 0) > 0 THEN 'items' ELSE 'none' END AS rx_state,
             COALESCE(ol.open_lines, 0) AS open_lines
      FROM products p
      JOIN fluence_customers fc ON fc.customer_id = p.customer_id
      ${KIT_OF_CARTON}
      LEFT JOIN (SELECT kit_id, COUNT(*)::int AS n FROM fluence_kit_components GROUP BY kit_id) kc ON kc.kit_id = k.id
      LEFT JOIN fluence_prescriptions rx ON rx.kit_id = k.id
      LEFT JOIN (SELECT prescription_id, COUNT(*)::int AS n,
                        COUNT(*) FILTER (WHERE COALESCE(morning_qty, 0) > 0 OR COALESCE(afternoon_qty, 0) > 0
                          OR COALESCE(evening_qty, 0) > 0 OR COALESCE(night_qty, 0) > 0 OR COALESCE(other_qty, 0) > 0
                          OR NULLIF(btrim(other_timing), '') IS NOT NULL OR NULLIF(btrim(dosage), '') IS NOT NULL
                          OR NULLIF(btrim(frequency), '') IS NOT NULL OR NULLIF(btrim(instructions), '') IS NOT NULL)::int AS dosed
                 FROM fluence_prescription_lines GROUP BY prescription_id) rl ON rl.prescription_id = rx.id
      LEFT JOIN (SELECT product_id, COUNT(*)::int AS open_lines FROM order_lines
                 WHERE status IN ('pending','planned','ready','in_production') GROUP BY product_id) ol ON ol.product_id = p.id
      ORDER BY p.code, p.id`));
  } catch (e) {
    offWhenMissing(res, next, [])(e);
  }
});

r.get('/fluence/kits', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT k.id, k.kit_name, k.source_ref, k.product_id, k.link_method, k.linked_at, k.linked_by,
             k.suggested_product_id, k.suggestion_reason, k.party_sl_no,
             to_char(k.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(k.valid_to, 'YYYY-MM-DD') AS valid_to,
             k.kit_type, k.kit_total_mrp, k.superseded_by_kit_id, sk.kit_name AS superseded_by_name,
             p.code AS product_code, p.name AS product_name,
             sp.code AS suggested_code, sp.name AS suggested_name, sk2.id AS suggested_taken_by_kit_id,
             COALESCE(kc.n, 0) AS components_count, kc.line_mrp, COALESCE(kp.n, 0) AS parts_count
      FROM fluence_kits k
      LEFT JOIN products p ON p.id = k.product_id
      LEFT JOIN products sp ON sp.id = k.suggested_product_id
      LEFT JOIN fluence_kits sk ON sk.id = k.superseded_by_kit_id
      LEFT JOIN fluence_kits sk2 ON sk2.product_id = k.suggested_product_id
      -- line_mrp: the one price every line carries, when they all carry the same (flat-priced kits)
      LEFT JOIN (SELECT kit_id, COUNT(*)::int AS n,
                        CASE WHEN COUNT(mrp_in_kit) = COUNT(*) AND COUNT(DISTINCT mrp_in_kit) = 1 THEN MIN(mrp_in_kit) END AS line_mrp
                 FROM fluence_kit_components GROUP BY kit_id) kc ON kc.kit_id = k.id
      LEFT JOIN (SELECT outer_product_id, COUNT(*)::int AS n FROM fluence_part_cartons GROUP BY outer_product_id) kp
             ON kp.outer_product_id = k.product_id
      WHERE k.source_ref LIKE 'customer-master:%'
      ORDER BY k.party_sl_no NULLS LAST, k.id`));
  } catch (e) {
    offWhenMissing(res, next, [])(e);
  }
});

// ── The change log: every change to the Fluence master, newest first ────────
// Kit lists, prescriptions and links (with their revisions), inner products, and
// Kit Studio's kits, drafts and clearances — who made each change and from where.
// A change from a customer's own login carries its login ID in the name.
r.get('/fluence/changes', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
    res.json(await q(`
      SELECT x.* FROM (
        SELECT 'r' || r.id AS id, r.changed_at AS at, r.changed_by AS who, r.changed_from AS from_ctx, r.area,
               r.revision, r.note AS detail, r.kit_id, k.kit_name, p.code AS product_code, p.name AS product_name
        FROM fluence_master_revisions r
        LEFT JOIN fluence_kits k ON k.id = r.kit_id
        LEFT JOIN products p ON p.id = k.product_id
        UNION ALL
        SELECT 'a' || a.id, a.created_at, a.user_name, NULL,
               CASE WHEN a.entity = 'fluence_inner_product' THEN 'inner_product_' || a.action
                    WHEN a.entity = 'kit_studio' THEN 'studio_' || a.action
                    ELSE 'kit_' || a.action END,
               NULL, a.detail, CASE WHEN a.entity = 'fluence_kit' THEN a.entity_id END, COALESCE(k.kit_name, ip.name), p.code, p.name
        FROM audit_log a
        LEFT JOIN fluence_kits k ON a.entity = 'fluence_kit' AND k.id = a.entity_id
        LEFT JOIN fluence_inner_products ip ON a.entity = 'fluence_inner_product' AND ip.id = a.entity_id
        LEFT JOIN products p ON p.id = k.product_id
        WHERE a.entity IN ('fluence_inner_product', 'kit_studio')
           OR (a.entity = 'fluence_kit' AND a.action IN ('create', 'delete', 'studio_saved'))
      ) x ORDER BY x.at DESC, x.id DESC LIMIT $1`, [limit]));
  } catch (e) {
    offWhenMissing(res, next, [])(e);
  }
});

r.get('/fluence/kits/:id/revisions', async (req, res, next) => {
  try {
    res.json(await q(`
      SELECT id, kit_id, area, revision, before, after, note, changed_by, changed_from, changed_at
      FROM fluence_master_revisions WHERE kit_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 100`, [req.params.id]));
  } catch (e) {
    offWhenMissing(res, next, [])(e);
  }
});

// Link a customer-list kit to the ERP product it is printed as. Only a person
// makes this link (the import links exact names only). If the product already
// carries a kit the plant started for it, that kit's records move across —
// nothing anybody entered is dropped.
// Which carton a customer kit is printed as decides the prescription on
// Colour Impressions' cartons: a product-master decision, with the Masters tick.
r.post('/fluence/kits/:id/link', canEditMaster, needsMasters, async (req, res, next) => {
  try {
    const productId = Number(req.body?.product_id);
    if (!(Number.isInteger(productId) && productId > 0)) throw fail(400, 'Choose the Fluence product this kit is printed as.');
    const from = contextOf(req.body?.from) || 'fluence_master';
    await tx(async (qc, oc) => {
      const kit = await oc('SELECT * FROM fluence_kits WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!kit) throw fail(404, 'Kit not found.');
      if (!String(kit.source_ref).startsWith('customer-master:')) throw fail(400, 'Only a kit from the customer list can be linked.');
      if (kit.product_id === productId) return;
      if (kit.product_id) throw fail(409, 'This kit is already linked to another product — unlink it first.');
      const product = await fluenceProduct(productId, oc);
      const outer = await outerCartonOf(productId, oc);
      if (outer) throw fail(409, `${product.code} is a part carton (${outer.part}) of ${outer.code} — it shows that carton's kit. Link the kit to the outer carton instead.`);
      const holder = await oc('SELECT * FROM fluence_kits WHERE product_id = $1 FOR UPDATE', [productId]);
      let note = null;
      if (holder) {
        if (String(holder.source_ref).startsWith('customer-master:')) {
          throw fail(409, `${product.code} is already linked to the customer kit "${holder.kit_name}". Unlink that kit first.`);
        }
        // A kit the plant started for this product: carry its records over.
        const [{ n: holderItems }] = await qc('SELECT COUNT(*)::int AS n FROM fluence_kit_components WHERE kit_id = $1', [holder.id]);
        const [{ n: kitItems }] = await qc('SELECT COUNT(*)::int AS n FROM fluence_kit_components WHERE kit_id = $1', [kit.id]);
        if (holderItems > 0 && kitItems > 0) {
          throw fail(409, `${product.code} already has its own list of ${holderItems} inner product(s), and this kit brings ${kitItems}. ` +
            'Clear one of the two lists before linking, so nothing is overwritten silently.');
        }
        const kitRx = await oc('SELECT id FROM fluence_prescriptions WHERE kit_id = $1', [kit.id]);
        const holderRx = await oc('SELECT id FROM fluence_prescriptions WHERE kit_id = $1', [holder.id]);
        if (kitRx && holderRx) throw fail(409, `Both ${product.code} and this kit carry a prescription. Resolve one before linking.`);
        if (holderItems > 0) await qc('UPDATE fluence_kit_components SET kit_id = $1 WHERE kit_id = $2', [kit.id, holder.id]);
        if (holderRx) await qc('UPDATE fluence_prescriptions SET kit_id = $1 WHERE id = $2', [kit.id, holderRx.id]);
        await qc('UPDATE fluence_master_revisions SET kit_id = $1 WHERE kit_id = $2', [kit.id, holder.id]);
        // A kit designed in Kit Studio: its size, layout and history there follow
        // the records across to the customer's kit — unless that kit already has
        // a studio entry of its own (the other one is then left unlinked there).
        if (String(holder.source_ref).startsWith('kit-studio:')) {
          const studio = await oc('SELECT id FROM kit_studio_kits WHERE fluence_kit_id = $1', [kit.id]);
          if (!studio) await qc('UPDATE kit_studio_kits SET fluence_kit_id = $1 WHERE fluence_kit_id = $2', [kit.id, holder.id]);
        }
        await qc('UPDATE fluence_kits SET product_id = NULL WHERE id = $1', [holder.id]);
        await qc('DELETE FROM fluence_kits WHERE id = $1', [holder.id]);
        note = `carried over the records the plant had entered for ${product.code}`;
      }
      const method = kit.suggested_product_id === productId ? 'confirmed_suggestion' : 'manual';
      await qc(`UPDATE fluence_kits SET product_id = $1, link_method = $2, linked_at = now(), linked_by = $3,
                  updated_at = now(), updated_by = $3 WHERE id = $4`, [productId, method, req.user.name, kit.id]);
      await recordRevision({ kitId: kit.id, area: 'kit_link', before: { product_id: null }, after: { product_id: productId, product_code: product.code, link_method: method }, note, user: req.user, from }, qc);
      await audit('fluence_kit', kit.id, 'kit_linked', `${kit.kit_name} → ${product.code} ${product.name} (${method.replace('_', ' ')})`, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/fluence/kits/:id/unlink', canEditMaster, needsMasters, async (req, res, next) => {
  try {
    const from = contextOf(req.body?.from) || 'fluence_master';
    await tx(async (qc, oc) => {
      const kit = await oc('SELECT k.*, p.code AS product_code, p.name AS product_name FROM fluence_kits k LEFT JOIN products p ON p.id = k.product_id WHERE k.id = $1 FOR UPDATE OF k', [req.params.id]);
      if (!kit) throw fail(404, 'Kit not found.');
      if (!String(kit.source_ref).startsWith('customer-master:')) throw fail(400, 'Only a kit from the customer list can be unlinked.');
      if (!kit.product_id) return;
      await qc('UPDATE fluence_kits SET product_id = NULL, link_method = NULL, linked_at = NULL, linked_by = NULL, updated_at = now(), updated_by = $1 WHERE id = $2', [req.user.name, kit.id]);
      await recordRevision({ kitId: kit.id, area: 'kit_link', before: { product_id: kit.product_id, product_code: kit.product_code }, after: { product_id: null }, user: req.user, from }, qc);
      await audit('fluence_kit', kit.id, 'kit_unlinked', `${kit.kit_name} ✕ ${kit.product_code} ${kit.product_name}`, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
