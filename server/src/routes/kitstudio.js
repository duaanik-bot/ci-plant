// Kit Studio — carton sizing, layouts and draft kits, on top of the Fluence
// kit master. The page itself is a stand-alone app served at
// /kit-studio-app/index.html and hosted by pages/KitStudio.jsx; every read and write
// it makes comes here.
//
// What it owns, what it borrows (see kit-studio.js for the full mapping):
//   • kit_studio_* rows — carton sizes and how sure we are of them, layouts,
//     drafts, the clearance settings. Written only here.
//   • the Fluence master — what is in a kit (fluence_kit_components) and an
//     inner product's MRP and confirmed size (fluence_inner_products). Read
//     live on every load and written THROUGH on save, with the same revision
//     and audit trail a save from the Fluence Master page leaves.
//   • the ERP product — a kit carton's size (products.size) is filled from a
//     CONFIRMED studio size only while it is empty. A different size already on
//     the product is never overwritten by a save; that takes the explicit
//     "Use in ERP" action, which is audited.
//   • the product master itself, once a kit is finalised: a new carton (the
//     next FP- code, the Fluence billing code, a print spec copied from a
//     similar kit) or a link to the product the carton already is. Only the
//     people who keep the product master (Masters: planner, admin) do this.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit, lockDocNumber, nextProductCode, placeholderBoardId, productCodeTaken } from '../helpers.js';
import { requireRole, PLANNING_ROLES } from '../auth.js';
import { keepRxInStep, tellManagement } from './fluence.js';
import { needsMasters } from '../access.js';
import {
  validId, nameKey, dimsOf, sizeText, parseSizeText, sameCarton, masterDimsFor,
  splitKit, splitProduct, splitDraft, splitSettings, kitDoc, productDoc,
  nextBillingCode, billingCodeOf, newProductRow, productInput, rankMatches,
} from '../kit-studio.js';

const r = Router();
const canEditStudio = requireRole(...PLANNING_ROLES);
const canEdit = user => user?.role === 'admin' || PLANNING_ROLES.includes(user?.role);
// The product master's own rule (masters.js: requireRole('planner'), admin
// implied) — and the Masters tick: a login without it (a customer's own) designs
// and sizes kits, while their cartons, billing codes and print spec stay with
// Masters (access.js).
const canKeepProducts = [requireRole('planner'), needsMasters];
const keepsProducts = req => (req.user?.role === 'admin' || req.user?.role === 'planner') && req.access?.masters === true;
const FROM = 'kit_studio';

// Every refusal names the studio: the studio page shows the message itself, so
// the ERP's central toast stays quiet for it (api.js HANDLED_BY).
const fail = (status, message) => Object.assign(new Error(message), { status, body: { code: 'KIT_STUDIO_REFUSED' } });
const MISSING_TABLE = '42P01';

// ── Reading ─────────────────────────────────────────────────────────────────

const KIT_ROWS = `
  SELECT fk.id, fk.kit_name, fk.source_ref, fk.party_sl_no, fk.product_id, fk.superseded_by_kit_id,
         p.code AS product_code, p.name AS product_name, p.party_item_code, p.size AS product_size
  FROM fluence_kits fk LEFT JOIN products p ON p.id = fk.product_id`;

async function loadState(qc = q) {
  const [kits, fks, comps, prods, inners, drafts, settings] = await Promise.all([
    qc('SELECT * FROM kit_studio_kits ORDER BY id'),
    qc(`${KIT_ROWS} ORDER BY fk.id`),
    qc('SELECT kit_id, inner_product_id, sr, qty_per_kit, mrp_in_kit FROM fluence_kit_components ORDER BY kit_id, sr, id'),
    qc('SELECT * FROM kit_studio_products ORDER BY id'),
    qc('SELECT id, name, kind, standard_mrp, carton_l, carton_w, carton_h, active, source FROM fluence_inner_products ORDER BY id'),
    qc('SELECT * FROM kit_studio_drafts ORDER BY id'),
    qc("SELECT * FROM kit_studio_settings WHERE id = 'main'"),
  ]);
  return compose({ kits, fks, comps, prods, inners, drafts, settings: settings[0] || null });
}

function compose({ kits, fks, comps, prods, inners, drafts, settings }) {
  const innerById = new Map(inners.map(i => [i.id, i]));
  const prodByInner = new Map(prods.filter(p => p.fluence_inner_product_id != null).map(p => [p.fluence_inner_product_id, p]));
  const pidOf = innerId => prodByInner.get(innerId)?.id ?? `i${innerId}`;
  const compsByKit = new Map();
  for (const c of comps) {
    if (!compsByKit.has(c.kit_id)) compsByKit.set(c.kit_id, []);
    compsByKit.get(c.kit_id).push(c);
  }
  const fkById = new Map(fks.map(k => [k.id, k]));
  const withKit = new Set();

  const kitOut = kits.map(k => {
    const fk = k.fluence_kit_id != null ? fkById.get(k.fluence_kit_id) : null;
    if (fk) withKit.add(fk.id);
    return { id: k.id, version: k.version, data: kitDoc(k, fk, fk ? compsByKit.get(fk.id) : null, pidOf) };
  });
  // A Fluence kit the studio has never saved still shows, read straight from the master.
  for (const fk of fks) {
    if (!withKit.has(fk.id)) kitOut.push({ id: `f${fk.id}`, version: 0, data: kitDoc(null, fk, compsByKit.get(fk.id), pidOf) });
  }

  const productOut = prods.map(p => ({
    id: p.id, version: p.version,
    data: productDoc(p, p.fluence_inner_product_id != null ? innerById.get(p.fluence_inner_product_id) : null),
  }));
  for (const i of inners) {
    if (!prodByInner.has(i.id)) productOut.push({ id: `i${i.id}`, version: 0, data: productDoc(null, i) });
  }

  return {
    kits: kitOut,
    products: productOut,
    drafts: drafts.map(d => ({ id: d.id, version: d.version, data: { ...d.data, updatedAt: d.updated_at, updatedBy: d.updated_by } })),
    settings: settings ? { id: 'main', version: settings.version, data: settings.data } : null,
  };
}

r.get('/kit-studio/state', async (req, res, next) => {
  try {
    const state = await loadState();
    res.json({ ...state, me: { name: req.user?.name ?? null, can_edit: canEdit(req.user), can_keep_products: keepsProducts(req), masters: req.access?.masters === true } });
  } catch (e) {
    if (e?.code === MISSING_TABLE) return res.json({ kits: [], products: [], drafts: [], settings: null, me: { name: req.user?.name ?? null, can_edit: false, can_keep_products: false }, missing: true });
    next(e);
  }
});

// ── Helpers shared by the writes ────────────────────────────────────────────

// The version a save was based on must still be the version on file.
function checkVersion(row, base, what) {
  const current = row?.version ?? 0;
  if (base != null && Number(base) !== current) {
    throw fail(409, `This ${what} was changed by ${row?.updated_by || 'someone else'} after you opened it. `
      + 'Your edit was not saved — the latest is on screen now; make your change again.');
  }
}

const componentsSnapshot = (kitId, qc) => qc(`
  SELECT kc.sr, kc.inner_product_id, ip.name, kc.qty_per_kit, kc.mrp_in_kit, kc.remarks
  FROM fluence_kit_components kc JOIN fluence_inner_products ip ON ip.id = kc.inner_product_id
  WHERE kc.kit_id = $1 ORDER BY kc.sr, kc.id`, [kitId]);

async function recordRevision(kitId, before, after, user, note, qc, area = 'components') {
  await qc(`
    INSERT INTO fluence_master_revisions (kit_id, area, before, after, note, changed_by, changed_by_id, changed_from)
    VALUES ($1, $8, $2::jsonb, $3::jsonb, $4, $5, $6, $7)`,
  [kitId, JSON.stringify(before), JSON.stringify(after), note, user.name, user.id ?? null, FROM, area]);
}

// Studio product ids → inner product ids. Every product the studio lists is in
// the inner product master, so an id that maps to nothing is a stale page —
// refused, unless the caller only compares (`strict: false` maps it to null).
async function innerIdsFor(pids, qc, { strict = true } = {}) {
  const rows = pids.length ? await qc(
    'SELECT id, fluence_inner_product_id FROM kit_studio_products WHERE id = ANY($1::text[])', [pids]) : [];
  const byId = new Map(rows.map(r => [r.id, r.fluence_inner_product_id]));
  const out = new Map();
  for (const pid of pids) {
    let inner = byId.get(pid) ?? null;
    if (inner == null) { const m = pid.match(/^i(\d+)$/); if (m) inner = Number(m[1]); }
    out.set(pid, inner);
  }
  const want = [...new Set([...out.values()].filter(v => v != null))];
  const found = want.length ? await qc('SELECT id FROM fluence_inner_products WHERE id = ANY($1::int[])', [want]) : [];
  const ok = new Set(found.map(f => f.id));
  for (const [pid, inner] of out) {
    if (inner == null || !ok.has(inner)) {
      if (strict) throw fail(400, 'One of the kit\'s products is not in the Fluence inner product master any more — reload the page and pick it again.');
      out.set(pid, null);
    }
  }
  return out;
}

// A kit already in the Fluence master has its contents changed in ONE place —
// the Contents & prescription editor, which keeps the prescription in step. The
// studio only reads them, so a save that carries a different kit list comes from
// a page older than that rule and is refused rather than quietly dropped.
async function assertSameContents(fkId, items, qc) {
  const master = await componentsSnapshot(fkId, qc);
  const innerOf = await innerIdsFor(items.map(i => i.pid), qc, { strict: false });
  const key = list => JSON.stringify(list.slice().sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const onFile = key(master.map(c => [c.inner_product_id, +c.qty_per_kit]));
  const sent = key(items.map(i => [innerOf.get(i.pid) ?? null, +i.q]));
  if (onFile !== sent) {
    throw fail(409, 'This kit’s contents are changed with “Edit contents & prescription” now, and the studio only reads them. '
      + 'Your other changes were not saved — reload the page and make them again.');
  }
}

// Write a kit's contents through to fluence_kit_components, the way the Fluence
// Master page does: only when something changed, with a revision and an audit
// line. Each item keeps the remarks the master already had for it.
async function writeComponents(fkId, items, innerOf, user, label, qc) {
  const before = await componentsSnapshot(fkId, qc);
  const remarks = new Map(before.map(c => [c.inner_product_id, c.remarks]));
  const next = items.map((it, i) => ({
    sr: i + 1, inner_product_id: innerOf.get(it.pid), qty_per_kit: it.q, mrp_in_kit: it.mrp,
    remarks: remarks.get(innerOf.get(it.pid)) ?? null,
  }));
  const norm = list => JSON.stringify(list.map(c => [c.inner_product_id, +c.qty_per_kit, c.mrp_in_kit == null ? null : +c.mrp_in_kit, c.remarks ?? null]));
  if (norm(before) === norm(next)) return false;
  await qc('DELETE FROM fluence_kit_components WHERE kit_id = $1', [fkId]);
  for (const c of next) {
    await qc(`
      INSERT INTO fluence_kit_components (kit_id, inner_product_id, sr, qty_per_kit, mrp_in_kit, remarks, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [fkId, c.inner_product_id, c.sr, c.qty_per_kit, c.mrp_in_kit, c.remarks, user.name]);
  }
  const after = await componentsSnapshot(fkId, qc);
  await recordRevision(fkId, before, after, user, null, qc);
  await audit('fluence_kit', fkId, 'kit_components_updated',
    `${label} — ${after.length} inner product(s), saved from Kit Studio`, qc, user.name);
  return true;
}

// Fill the kit carton's ERP product size from a CONFIRMED studio size — only
// while the product has none, unless `force` (the explicit "Use in ERP" action).
// Returns what happened, for the page to say.
async function writeErpSize(fk, row, user, qc, { force = false } = {}) {
  if (!fk?.product_id) return { erp: 'no product' };
  const d = dimsOf({ L: row.carton_l, W: row.carton_w, H: row.carton_h });
  if (row.size_status !== 'CONFIRMED' || !d) return { erp: 'not confirmed' };
  const p = (await qc('SELECT id, code, size FROM products WHERE id = $1 FOR UPDATE', [fk.product_id]))[0];
  if (!p) return { erp: 'no product' };
  const cur = String(p.size ?? '').trim();
  const want = sizeText(d);
  if (cur && sameCarton(parseSizeText(cur), d)) return { erp: 'same' };
  if (cur && !force) return { erp: 'differs', erpSize: cur };
  await qc('UPDATE products SET size = $1 WHERE id = $2', [want, p.id]);
  await audit('product', p.id, 'master_update', `from Kit Studio: size: ${cur || '—'} → ${want}`, qc, user.name);
  return { erp: cur ? 'replaced' : 'filled', erpSize: want };
}

const upsertKitRow = (id, fkId, row, user, qc) => qc(`
  INSERT INTO kit_studio_kits (id, fluence_kit_id, name, family, carton_l, carton_w, carton_h, size_status, size_source, data, created_by, updated_by)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11)
  ON CONFLICT (id) DO UPDATE SET
    fluence_kit_id = EXCLUDED.fluence_kit_id, name = EXCLUDED.name, family = EXCLUDED.family,
    carton_l = EXCLUDED.carton_l, carton_w = EXCLUDED.carton_w, carton_h = EXCLUDED.carton_h,
    size_status = EXCLUDED.size_status, size_source = EXCLUDED.size_source, data = EXCLUDED.data,
    version = kit_studio_kits.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING *`,
[id, fkId, row.name, row.family, row.carton_l, row.carton_w, row.carton_h, row.size_status, row.size_source, JSON.stringify(row.data), user.name]);

async function composeOne(coll, id) {
  const state = await loadState();
  return state[coll].find(d => d.id === id) || null;
}

// ── Kits ────────────────────────────────────────────────────────────────────

r.put('/kit-studio/kits/:id', canEditStudio, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!validId(id)) throw fail(400, 'Not a valid kit id.');
    const { errors, row, items } = splitKit(req.body?.doc);
    if (errors.length) throw fail(400, errors.join(' '));
    const outcome = await tx(async (qc, oc) => {
      const cur = await oc('SELECT * FROM kit_studio_kits WHERE id = $1 FOR UPDATE', [id]);
      checkVersion(cur, req.body?.base_version, 'kit');

      // Which Fluence kit this is: the one it is already tied to, or — for a
      // kit first opened from the master ('f<id>') — that one.
      let fkId = cur?.fluence_kit_id ?? null;
      if (fkId == null && !cur) {
        const m = id.match(/^f(\d+)$/);
        if (m) fkId = Number(m[1]);
      }
      let fk = fkId != null ? await oc(`${KIT_ROWS} WHERE fk.id = $1 FOR UPDATE OF fk`, [fkId]) : null;
      if (fkId != null && !fk) throw fail(409, 'This kit is no longer in the Fluence master — reload the page.');
      if (fk && !cur) {
        const taken = await oc('SELECT id FROM kit_studio_kits WHERE fluence_kit_id = $1', [fk.id]);
        if (taken) throw fail(409, 'This Fluence kit is already open in the studio under another entry — reload the page.');
      }

      let created = null;
      if (!fk) {
        // A kit designed in the studio becomes a Fluence kit when it is saved
        // as a kit: unlinked (no product yet) until its carton goes into the
        // product master, like any other kit on the customer's list.
        created = await oc(`
          INSERT INTO fluence_kits (kit_name, source_ref, remarks, created_by, updated_by)
          VALUES ($1, $2, 'Created in Kit Studio', $3, $3)
          ON CONFLICT (source_ref) DO UPDATE SET updated_at = now()
          RETURNING id`, [row.name, `kit-studio:${id}`, req.user.name]);
        await audit('fluence_kit', created.id, 'create', `${row.name} — created in Kit Studio`, qc, req.user.name);
        fk = await oc(`${KIT_ROWS} WHERE fk.id = $1`, [created.id]);
      } else if (fk.source_ref === `kit-studio:${id}` && fk.kit_name !== row.name) {
        // The studio's own kit: its name is the studio's to change.
        await qc('UPDATE fluence_kits SET kit_name = $1, updated_at = now(), updated_by = $2 WHERE id = $3', [row.name, req.user.name, fk.id]);
      }
      if (fk.source_ref !== `kit-studio:${id}`) row.name = fk.kit_name; // a master kit keeps the customer's name

      // The kit list is written only when the kit is born here (Push to Kits),
      // and its prescription starts in step with it: a bare line per item.
      // After that, contents change in the Contents & prescription editor.
      let componentsChanged = false;
      if (created) {
        const innerOf = await innerIdsFor(items.map(i => i.pid), qc);
        componentsChanged = await writeComponents(fk.id, items, innerOf, req.user, fk.kit_name, qc);
        await keepRxInStep(fk.id, req.user, FROM, qc, oc);
      } else {
        await assertSameContents(fk.id, items, qc);
      }
      const saved = await upsertKitRow(id, fk.id, row, req.user, qc);
      // A confirmed size fills an empty product size — a product-master write,
      // so only for a login with the Masters tick.
      const erp = req.access?.masters === true ? await writeErpSize(fk, saved[0], req.user, qc) : { erp: 'kept in Masters' };
      const sizeLine = dimsOf({ L: row.carton_l, W: row.carton_w, H: row.carton_h }) ? `${row.carton_l} × ${row.carton_w} × ${row.carton_h} mm (${row.size_status})` : 'size not set';
      const what = String(req.body?.doc?.history?.[0]?.what ?? '').trim();
      if (created) {
        await tellManagement(req.user, { kitId: fk.id, subject: `New kit ${row.name}`, change: `added in Kit Studio — ${items.length} item(s), ${sizeLine}` }, qc);
      } else {
        await audit('fluence_kit', fk.id, 'studio_saved', `${row.name} — ${what || `saved in Kit Studio, ${sizeLine}`}`.slice(0, 1000), qc, req.user.name);
        await tellManagement(req.user, { kitId: fk.id, subject: `Kit ${row.name}`, change: `Kit Studio: ${(what || sizeLine).slice(0, 400)}` }, qc);
      }
      return { version: saved[0].version, componentsChanged, ...erp };
    });
    res.json({ id, ...outcome, doc: await composeOne('kits', id) });
  } catch (e) { next(e); }
});

// "Use in ERP": replace the kit carton's product size with the studio's
// CONFIRMED size. Only ever a deliberate click — a save never does this.
r.post('/kit-studio/kits/:id/erp-size', canEditStudio, needsMasters, async (req, res, next) => {
  try {
    const id = req.params.id;
    const outcome = await tx(async (qc, oc) => {
      const row = await oc('SELECT * FROM kit_studio_kits WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw fail(404, 'Save the kit in the studio first.');
      if (row.size_status !== 'CONFIRMED') throw fail(409, 'Only a CONFIRMED size can go to the ERP product. Confirm it first.');
      const fk = row.fluence_kit_id != null ? await oc(`${KIT_ROWS} WHERE fk.id = $1`, [row.fluence_kit_id]) : null;
      if (!fk?.product_id) throw fail(409, 'This kit is not linked to an ERP product yet — link it in the Fluence Master first.');
      return writeErpSize(fk, row, req.user, qc, { force: true });
    });
    res.json({ id, ...outcome, doc: await composeOne('kits', id) });
  } catch (e) { next(e); }
});

r.delete('/kit-studio/kits/:id', canEditStudio, async (req, res, next) => {
  try {
    const id = req.params.id;
    await tx(async (qc, oc) => {
      const row = await oc('SELECT * FROM kit_studio_kits WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw fail(409, 'This kit is in the Fluence master — it can only be retired there, not deleted from the studio.');
      checkVersion(row, req.query.base_version ?? req.body?.base_version, 'kit');
      const fk = row.fluence_kit_id != null
        ? await oc('SELECT id, source_ref, product_id FROM fluence_kits WHERE id = $1 FOR UPDATE', [row.fluence_kit_id]) : null;
      if (fk) {
        if (fk.source_ref !== `kit-studio:${id}`) throw fail(409, 'This kit is in the Fluence master — it can only be retired there, not deleted from the studio.');
        if (fk.product_id) throw fail(409, 'This kit is linked to an ERP product. Unlink it first (In the ERP → Unlink) before deleting it here.');
        // Its prescription goes with it — unless someone has entered doses on it.
        const dosed = await oc(`
          SELECT r.id FROM fluence_prescriptions r
          WHERE r.kit_id = $1 AND (NULLIF(btrim(r.general_instructions), '') IS NOT NULL OR EXISTS (
            SELECT 1 FROM fluence_prescription_lines l WHERE l.prescription_id = r.id AND (
              COALESCE(l.morning_qty, 0) > 0 OR COALESCE(l.afternoon_qty, 0) > 0 OR COALESCE(l.evening_qty, 0) > 0
              OR COALESCE(l.night_qty, 0) > 0 OR COALESCE(l.other_qty, 0) > 0 OR NULLIF(btrim(l.other_timing), '') IS NOT NULL
              OR NULLIF(btrim(l.dosage), '') IS NOT NULL OR NULLIF(btrim(l.frequency), '') IS NOT NULL
              OR NULLIF(btrim(l.instructions), '') IS NOT NULL)))`, [fk.id]);
        if (dosed) throw fail(409, 'Doses are entered on this kit’s prescription — clear them first if the kit really goes.');
        await qc('DELETE FROM fluence_kits WHERE id = $1', [fk.id]);
        await audit('fluence_kit', fk.id, 'delete', `${row.name} — deleted in Kit Studio (never linked to a product)`, qc, req.user.name);
      }
      await qc('DELETE FROM kit_studio_kits WHERE id = $1', [id]);
      await tellManagement(req.user, { subject: `Kit ${row.name}`, change: 'deleted in Kit Studio', link: '/fluence?tab=kits' }, qc);
    });
    res.json({ id, deleted: true });
  } catch (e) { next(e); }
});

// ── The kit carton in the product master ────────────────────────────────────
//
// Once a kit is finalised its carton goes into the product master: either a new
// product (the next FP- code, the Fluence billing code, a print spec copied from
// a similar kit — always marked spec incomplete, for Planning to finish) or, when
// the carton is already there because an order brought it in, a link to that
// product. Never both: a carton under two codes splits its orders and invoices.

// The kit an action is about: its studio row (none for a customer kit the studio
// has never saved — 'f<id>') and its Fluence kit joined to the linked product.
async function erpKitFor(id, oc, { lock = false } = {}) {
  if (!validId(id)) throw fail(400, 'Not a valid kit id.');
  const row = await oc(`SELECT * FROM kit_studio_kits WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  let fkId = row?.fluence_kit_id ?? null;
  if (!row) {
    const m = id.match(/^f(\d+)$/);
    if (!m) throw fail(404, 'This kit is not in the studio any more — reload the page.');
    fkId = Number(m[1]);
    const held = await oc('SELECT id FROM kit_studio_kits WHERE fluence_kit_id = $1', [fkId]);
    if (held) throw fail(409, 'This kit is open in the studio under another entry — reload the page.');
  }
  if (fkId == null) throw fail(409, 'Save this kit first — it is not in the Fluence master yet.');
  const fk = await oc(`${KIT_ROWS} WHERE fk.id = $1${lock ? ' FOR UPDATE OF fk' : ''}`, [fkId]);
  if (!fk) throw fail(409, 'This kit is no longer in the Fluence master — reload the page.');
  const own = fk.source_ref === `kit-studio:${id}`;
  return { row, fk, own, name: row && own ? row.name : fk.kit_name, dims: row ? dimsOf({ L: row.carton_l, W: row.carton_w, H: row.carton_h }) : null };
}

// Only a kit with no carton yet takes one — and never an old listing of a kit
// the customer has since re-listed under a newer entry.
function assertNoCarton(k) {
  if (k.fk.product_id) throw fail(409, `This kit is already ${k.fk.product_code} ${k.fk.product_name} in the ERP — reload the page.`);
  if (k.fk.superseded_by_kit_id != null) throw fail(409, 'The Fluence master lists this kit again under a newer entry — put that one in the ERP instead.');
}

// The highest Fluence billing code on record: every Fluence product's, and the
// code a kit carries while it has no product (a linked kit shows its product's
// code, so its own copy claims nothing). 8-digit strings, so text order is
// number order.
const TOP_BILLING_CODE = `
  SELECT max(code) AS top FROM (
    SELECT btrim(p.party_item_code) AS code FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id
     WHERE btrim(p.party_item_code) ~ '^20[0-9]{6}$'
    UNION ALL
    SELECT s.data->>'code' FROM kit_studio_kits s LEFT JOIN fluence_kits k ON k.id = s.fluence_kit_id
     WHERE s.data->>'code' ~ '^20[0-9]{6}$' AND k.product_id IS NULL) x`;

// Who already carries this billing code, other than the product and the kit it is for.
async function billingCodeHolder(code, { productId = null, studioId = null }, oc) {
  const p = await oc(`
    SELECT p.code, p.name FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id
    WHERE btrim(p.party_item_code) = $1 AND ($2::int IS NULL OR p.id <> $2) ORDER BY p.id LIMIT 1`, [code, productId]);
  if (p) return `on ${p.code} ${p.name}`;
  const k = await oc(`
    SELECT s.name FROM kit_studio_kits s LEFT JOIN fluence_kits k ON k.id = s.fluence_kit_id
    WHERE s.data->>'code' = $1 AND k.product_id IS NULL AND ($2::text IS NULL OR s.id <> $2) ORDER BY s.id LIMIT 1`, [code, studioId]);
  return k ? `the code of the kit ${k.name}` : null;
}

// Invoices run on the billing code, so one code is one carton. Every write of a
// code queues on the same lock first — two saves at once cannot both take it.
async function claimBillingCode(code, who, oc) {
  await lockDocNumber('fluence-billing-code', oc);
  const holder = await billingCodeHolder(code, who, oc);
  if (holder) throw fail(409, `Billing code ${code} is already ${holder}. Use another, or leave it blank until Fluence issues one.`);
  return code;
}

// A Fluence product's print spec, as a new carton copies it.
const SPEC_ROW = `
  SELECT p.id, p.code, p.name, p.size, p.customer_id, p.board_material_id, p.board_name, p.board_grade, p.gsm, p.colors,
         p.colour_type, p.print_process, p.cmyk_colours, p.pantone_colours, p.metallic_colours, p.coating, p.special,
         p.emboss, p.leafing, p.leafing_colour, p.pasting_type, p.product_type, p.wastage_pct,
         p.die_number, p.tool_id, t.code AS tool_code, p.ups, p.child_l, p.child_w, p.parent_l, p.parent_w
  FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id LEFT JOIN tools t ON t.id = p.tool_id`;

// Fluence products no kit holds yet — what a finalised kit's carton may already
// be. A part carton (a Topico tray, a leaflet) never holds a kit: its outer does.
const FREE_PRODUCTS = `
  SELECT p.id, p.code, p.name, p.size, p.mrp, p.party_item_code,
         (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.product_id = p.id AND ol.status <> 'cancelled') AS order_lines
  FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id
  WHERE COALESCE(p.active, 1) = 1
    AND NOT EXISTS (SELECT 1 FROM fluence_kits k WHERE k.product_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM fluence_part_cartons pc WHERE pc.product_id = p.id)`;

// The customer a new carton is filed under: the one its spec comes from, or —
// with nothing to copy — the only Fluence customer there is.
async function soleFluenceCustomer(qc) {
  const rows = await qc('SELECT customer_id FROM fluence_customers ORDER BY customer_id');
  if (rows.length === 1) return rows[0].customer_id;
  throw fail(400, rows.length ? 'Pick the kit to copy the print spec from — it decides which Fluence customer the carton is filed under.'
    : 'Fluence is not set up in this ERP.');
}

// Link a kit to its carton the way the Fluence Master does: a revision and an
// audit line on the kit.
async function linkKit(fk, product, user, note, qc) {
  await qc(`UPDATE fluence_kits SET product_id = $1, link_method = 'manual', linked_at = now(), linked_by = $2,
              updated_at = now(), updated_by = $2 WHERE id = $3`, [product.id, user.name, fk.id]);
  await recordRevision(fk.id, { product_id: null },
    { product_id: product.id, product_code: product.code, link_method: 'manual' }, user, note, qc, 'kit_link');
  await audit('fluence_kit', fk.id, 'kit_linked', `${fk.kit_name} → ${product.code} ${product.name} (${note})`, qc, user.name);
}

// Everything the product-master dialog needs, read fresh each time it opens:
// the next FP- code and billing code, the products this kit's carton may already
// be (best match first), and the print spec of the kits the page offers to copy
// (?refs=1,2,3). Reads only — the FP- code is previewed on the series lock and
// taken for real by the POST below.
r.get('/kit-studio/kits/:id/erp-options', needsMasters, async (req, res, next) => {
  try {
    const refIds = [...new Set(String(req.query.refs ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 40);
    const out = await tx(async (qc, oc) => {
      const k = await erpKitFor(req.params.id, oc);
      const own = billingCodeOf(k.row?.data?.code);
      const top = await oc(TOP_BILLING_CODE);
      const free = await qc(FREE_PRODUCTS);
      const refs = refIds.length ? await qc(`${SPEC_ROW} WHERE p.id = ANY($1::int[])`, [refIds]) : [];
      const customers = await qc('SELECT customer_id FROM fluence_customers ORDER BY customer_id');
      return {
        kit: {
          id: req.params.id, name: k.name, own: k.own, size: k.dims ? sizeText(k.dims) : null, size_status: k.row?.size_status ?? 'MISSING',
          product: k.fk.product_id ? { id: k.fk.product_id, code: k.fk.product_code, name: k.fk.product_name } : null,
          superseded: k.fk.superseded_by_kit_id != null,
        },
        billing: { next: nextBillingCode([top?.top]), own, own_taken_by: own ? await billingCodeHolder(own, { studioId: k.row?.id ?? null }, oc) : null },
        matches: rankMatches({ name: k.name, dims: k.dims }, free),
        refs: refs.map(p => ({ ...p, same_size: sameCarton(parseSizeText(p.size), k.dims) })),
        can_keep_products: keepsProducts(req),
        // Last, so the series lock is held for no longer than the commit.
        fp_code: customers.length ? await nextProductCode(customers[0].customer_id, qc, oc) : null,
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// A new carton for a finalised kit, and the kit linked to it — one transaction,
// so either all of it is there or none of it.
r.post('/kit-studio/kits/:id/erp-product', canKeepProducts, async (req, res, next) => {
  let code = null;
  try {
    const id = req.params.id;
    const input = productInput(req.body);
    if (input.errors.length) throw fail(400, input.errors.join(' '));
    const outcome = await tx(async (qc, oc) => {
      const k = await erpKitFor(id, oc, { lock: true });
      assertNoCarton(k);
      const ref = input.refId ? await oc(`${SPEC_ROW} WHERE p.id = $1`, [input.refId]) : null;
      if (input.refId && !ref) throw fail(400, 'The kit to copy the print spec from is not a Fluence product — pick it again.');
      const same = await oc(`
        SELECT p.code, p.name FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id
        WHERE regexp_replace(upper(p.name), '[^A-Z0-9+]', '', 'g') = $1 ORDER BY p.id LIMIT 1`, [nameKey(input.name)]);
      if (same) throw fail(409, `${same.code} ${same.name} is already in the product master — link this kit to it instead of making a second product.`);
      const billingCode = input.billingCode ? await claimBillingCode(input.billingCode, { studioId: k.row?.id ?? null }, oc) : null;
      const customerId = ref ? ref.customer_id : await soleFluenceCustomer(qc);
      const boardId = ref ? null : await placeholderBoardId(oc);
      if (!ref && !boardId) throw fail(409, 'Create a board material first.');
      const sameSize = !!(ref && sameCarton(parseSizeText(ref.size), k.dims));
      const size = k.row?.size_status === 'CONFIRMED' && k.dims ? sizeText(k.dims) : null;
      code = await nextProductCode(customerId, qc, oc);
      const values = newProductRow({ customerId, name: input.name, code, billingCode, mrp: input.mrp, size, ref, sameSize, boardId });
      const cols = Object.keys(values);
      const product = await oc(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, code, name`,
        cols.map(c => values[c]));
      const spec = ref
        ? `print spec from ${ref.code} ${ref.name}${sameSize ? ', with its die and sheet layout (same carton size)' : ' — board and print only (a different size: no die or sheet layout)'}`
        : 'no print spec copied (placeholder board)';
      await audit('products', product.id, 'create',
        `from Kit Studio, kit "${k.name}" · billing code ${billingCode || 'none yet'} · ${spec}`, qc, req.user.name);
      await linkKit(k.fk, product, req.user, 'product master created from the kit in Kit Studio', qc);
      return { product: { ...product, party_item_code: billingCode }, spec_from: ref ? { code: ref.code, name: ref.name, die: sameSize } : null };
    });
    res.json({ id, ...outcome, doc: await composeOne('kits', id) });
  } catch (e) { next(productCodeTaken(e, code, true)); }
});

// The carton is already in the product master — an order brought it in before
// the kit was finalised here. Link the kit to it. A billing code or MRP the
// product lacks is filled from the dialog; one it already has is never changed
// here (that is Masters' job, with its own history).
r.post('/kit-studio/kits/:id/erp-link', canKeepProducts, async (req, res, next) => {
  try {
    const id = req.params.id;
    const productId = Number(req.body?.product_id);
    if (!(Number.isInteger(productId) && productId > 0)) throw fail(400, 'Choose the ERP product this kit is printed as.');
    const input = productInput(req.body, { create: false });
    if (input.errors.length) throw fail(400, input.errors.join(' '));
    const outcome = await tx(async (qc, oc) => {
      const k = await erpKitFor(id, oc, { lock: true });
      assertNoCarton(k);
      const p = await oc(`
        SELECT p.* FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id
        WHERE p.id = $1 FOR UPDATE OF p`, [productId]);
      if (!p) throw fail(400, 'That product is not a Fluence product.');
      const part = await oc(`
        SELECT pc.part, op.code FROM fluence_part_cartons pc JOIN products op ON op.id = pc.outer_product_id
        WHERE pc.product_id = $1`, [productId]);
      if (part) throw fail(409, `${p.code} is a part carton (${part.part}) of ${part.code} — a kit links to its outer carton.`);
      const holder = await oc('SELECT kit_name FROM fluence_kits WHERE product_id = $1', [productId]);
      if (holder) throw fail(409, `${p.code} ${p.name} already carries the kit "${holder.kit_name}".`);
      const fills = {};
      if (input.billingCode && !String(p.party_item_code ?? '').trim()) {
        fills.party_item_code = await claimBillingCode(input.billingCode, { productId: p.id, studioId: k.row?.id ?? null }, oc);
      }
      if (input.mrp != null && p.mrp == null) fills.mrp = input.mrp;
      const keys = Object.keys(fills);
      if (keys.length) {
        await qc(`UPDATE products SET ${keys.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [p.id, ...keys.map(c => fills[c])]);
        await audit('product', p.id, 'master_update', `from Kit Studio: ${keys.map(c => `${c}: — → ${fills[c]}`).join('; ')}`, qc, req.user.name);
      }
      await linkKit(k.fk, p, req.user, 'linked in Kit Studio', qc);
      const erp = k.row ? await writeErpSize({ product_id: p.id }, k.row, req.user, qc) : { erp: 'not confirmed' };
      return { product: { id: p.id, code: p.code, name: p.name, party_item_code: fills.party_item_code ?? p.party_item_code ?? null }, filled: keys, ...erp };
    });
    res.json({ id, ...outcome, doc: await composeOne('kits', id) });
  } catch (e) { next(e); }
});

// Undo a link made here: the studio's own kit lets go of its carton. The product
// stays as it is — retire it in Masters if it was made by mistake. A kit from the
// customer's list is unlinked in the Fluence Master, where it was linked.
r.post('/kit-studio/kits/:id/erp-unlink', canKeepProducts, async (req, res, next) => {
  try {
    const id = req.params.id;
    await tx(async (qc, oc) => {
      const k = await erpKitFor(id, oc, { lock: true });
      if (!k.own) throw fail(409, 'This kit is on the customer\'s kit list — unlink it in the Fluence Master.');
      if (!k.fk.product_id) return;
      await qc(`UPDATE fluence_kits SET product_id = NULL, link_method = NULL, linked_at = NULL, linked_by = NULL,
                  updated_at = now(), updated_by = $1 WHERE id = $2`, [req.user.name, k.fk.id]);
      await recordRevision(k.fk.id, { product_id: k.fk.product_id, product_code: k.fk.product_code }, { product_id: null },
        req.user, 'unlinked in Kit Studio', qc, 'kit_link');
      await audit('fluence_kit', k.fk.id, 'kit_unlinked', `${k.fk.kit_name} ✕ ${k.fk.product_code} ${k.fk.product_name} — in Kit Studio`, qc, req.user.name);
    });
    res.json({ id, doc: await composeOne('kits', id) });
  } catch (e) { next(e); }
});

// ── Inner products ──────────────────────────────────────────────────────────

r.put('/kit-studio/products/:id', canEditStudio, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!validId(id)) throw fail(400, 'Not a valid product id.');
    const { errors, row, mrp } = splitProduct(req.body?.doc);
    if (errors.length) throw fail(400, errors.join(' '));
    const outcome = await tx(async (qc, oc) => {
      const cur = await oc('SELECT * FROM kit_studio_products WHERE id = $1 FOR UPDATE', [id]);
      checkVersion(cur, req.body?.base_version, 'product');
      let innerId = cur?.fluence_inner_product_id ?? null;
      if (innerId == null && !cur) {
        const m = id.match(/^i(\d+)$/);
        if (m) innerId = Number(m[1]);
      }
      let inner = innerId != null ? await oc('SELECT * FROM fluence_inner_products WHERE id = $1 FOR UPDATE', [innerId]) : null;
      if (innerId != null && !inner) throw fail(409, 'This product is no longer in the Fluence inner product master — reload the page.');

      if (!inner) {
        // New in the studio. Same name as a master entry nobody in the studio
        // holds yet → it IS that entry; otherwise it joins the master.
        const clash = await oc('SELECT * FROM fluence_inner_products WHERE name_key = $1 FOR UPDATE', [nameKey(row.name)]);
        if (clash) {
          const held = await oc('SELECT id FROM kit_studio_products WHERE fluence_inner_product_id = $1', [clash.id]);
          if (held) throw fail(409, `"${clash.name}" is already in the studio — use that one.`);
          inner = clash;
        } else {
          const d = masterDimsFor(row);
          inner = await oc(`
            INSERT INTO fluence_inner_products (name, name_key, kind, standard_mrp, carton_l, carton_w, carton_h, source, created_by, updated_by)
            VALUES ($1, $2, 'item', $3, $4, $5, $6, 'kit-studio', $7, $7) RETURNING *`,
          [row.name, nameKey(row.name), mrp, d?.L ?? null, d?.W ?? null, d?.H ?? null, req.user.name]);
          await audit('fluence_inner_product', inner.id, 'create', `${inner.name} — added in Kit Studio`, qc, req.user.name);
        }
      }
      if (!cur) {
        const held = await oc('SELECT id FROM kit_studio_products WHERE fluence_inner_product_id = $1', [inner.id]);
        if (held) throw fail(409, `"${inner.name}" is already in the studio — use that one.`);
      }

      // Write through what the master keeps: the MRP, and the size once it is
      // CONFIRMED (anything less clears the master's size: "not known yet").
      const d = masterDimsFor(row);
      const want = { standard_mrp: mrp, carton_l: d?.L ?? null, carton_w: d?.W ?? null, carton_h: d?.H ?? null };
      if (inner.source === 'kit-studio' && inner.name !== row.name) {
        const other = await oc('SELECT name FROM fluence_inner_products WHERE name_key = $1 AND id <> $2', [nameKey(row.name), inner.id]);
        if (other) throw fail(409, `"${other.name}" is already in the inner product master.`);
        want.name = row.name;
        want.name_key = nameKey(row.name);
      }
      const eq = (a, b) => (a == null && b == null) || (a != null && b != null && String(+a) === String(+b)) || String(a) === String(b);
      const changed = Object.keys(want).filter(k => !eq(inner[k], want[k]));
      if (changed.length) {
        const sets = changed.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await qc(`UPDATE fluence_inner_products SET ${sets}, updated_at = now(), updated_by = $${changed.length + 2} WHERE id = $1`,
          [inner.id, ...changed.map(k => want[k]), req.user.name]);
        await audit('fluence_inner_product', inner.id, 'update',
          `from Kit Studio: ${changed.filter(k => k !== 'name_key').map(k => `${k}: ${inner[k] ?? '—'} → ${want[k] ?? '—'}`).join('; ')}`.slice(0, 1000),
          qc, req.user.name);
      }
      if (inner.source !== 'kit-studio') row.name = inner.name; // a master product keeps the master's name
      const saved = await oc(`
        INSERT INTO kit_studio_products (id, fluence_inner_product_id, name, carton_l, carton_w, carton_h, size_status, data, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)
        ON CONFLICT (id) DO UPDATE SET
          fluence_inner_product_id = EXCLUDED.fluence_inner_product_id, name = EXCLUDED.name,
          carton_l = EXCLUDED.carton_l, carton_w = EXCLUDED.carton_w, carton_h = EXCLUDED.carton_h,
          size_status = EXCLUDED.size_status, data = EXCLUDED.data,
          version = kit_studio_products.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING version`,
      [id, inner.id, row.name, row.carton_l, row.carton_w, row.carton_h, row.size_status, JSON.stringify(row.data), req.user.name]);
      const told = changed.filter(k => k !== 'name_key').map(k => `${k}: ${inner[k] ?? '—'} → ${want[k] ?? '—'}`);
      if (!cur || told.length) {
        await tellManagement(req.user, {
          subject: `Inner product ${row.name}`,
          change: !cur ? `added in Kit Studio${told.length ? ` — ${told.join('; ')}` : ''}` : `Kit Studio: ${told.join('; ')}`,
          link: '/fluence?tab=inner',
        }, qc);
      }
      return { version: saved.version, masterChanged: changed.filter(k => k !== 'name_key') };
    });
    res.json({ id, ...outcome, doc: await composeOne('products', id) });
  } catch (e) { next(e); }
});

// ── Drafts and settings ─────────────────────────────────────────────────────

r.put('/kit-studio/drafts/:id', canEditStudio, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!validId(id)) throw fail(400, 'Not a valid draft id.');
    const { name, data } = splitDraft(req.body?.doc);
    const version = await tx(async (qc, oc) => {
      const cur = await oc('SELECT version, updated_by FROM kit_studio_drafts WHERE id = $1 FOR UPDATE', [id]);
      checkVersion(cur, req.body?.base_version, 'draft');
      const saved = await oc(`
        INSERT INTO kit_studio_drafts (id, name, data, created_by, updated_by) VALUES ($1,$2,$3::jsonb,$4,$4)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data,
          version = kit_studio_drafts.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING version`, [id, name, JSON.stringify(data), req.user.name]);
      await audit('kit_studio', null, cur ? 'draft_saved' : 'draft_created', `Draft kit ${name}`, qc, req.user.name);
      await tellManagement(req.user, { subject: `Draft kit ${name}`, change: cur ? 'saved in Kit Studio' : 'started in Kit Studio', link: '/fluence?tab=drafts' }, qc);
      return saved.version;
    });
    res.json({ id, version });
  } catch (e) { next(e); }
});

r.delete('/kit-studio/drafts/:id', canEditStudio, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const gone = await oc('DELETE FROM kit_studio_drafts WHERE id = $1 RETURNING name', [req.params.id]);
      if (!gone) return;
      await audit('kit_studio', null, 'draft_deleted', `Draft kit ${gone.name}`, qc, req.user.name);
      await tellManagement(req.user, { subject: `Draft kit ${gone.name}`, change: 'deleted in Kit Studio', link: '/fluence?tab=drafts' }, qc);
    });
    res.json({ id: req.params.id, deleted: true });
  } catch (e) { next(e); }
});

r.put('/kit-studio/settings/main', canEditStudio, async (req, res, next) => {
  try {
    const { errors, data } = splitSettings(req.body?.doc);
    if (errors.length) throw fail(400, errors.join(' '));
    const version = await tx(async (qc, oc) => {
      const cur = await oc("SELECT version, updated_by FROM kit_studio_settings WHERE id = 'main' FOR UPDATE");
      checkVersion(cur, req.body?.base_version, 'setting');
      const saved = await oc(`
        INSERT INTO kit_studio_settings (id, data, updated_by) VALUES ('main', $1::jsonb, $2)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = kit_studio_settings.version + 1,
          updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING version`, [JSON.stringify(data), req.user.name]);
      await audit('kit_studio', null, 'settings', 'Kit Studio clearances changed', qc, req.user.name);
      await tellManagement(req.user, { subject: 'Kit Studio clearances', change: 'changed — every kit size recommendation follows them', link: '/fluence?tab=settings' }, qc);
      return saved.version;
    });
    res.json({ id: 'main', version });
  } catch (e) { next(e); }
});

export { compose as composeKitStudioState };
export default r;
