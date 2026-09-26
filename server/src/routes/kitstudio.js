// Kit Studio — carton sizing, layouts and draft kits, on top of the Fluence
// kit master. The page itself is a stand-alone app served at
// /kit-studio/index.html and hosted by pages/KitStudio.jsx; every read and write
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
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole, PLANNING_ROLES } from '../auth.js';
import {
  validId, nameKey, dimsOf, sizeText, parseSizeText, sameCarton, masterDimsFor,
  splitKit, splitProduct, splitDraft, splitSettings, kitDoc, productDoc,
} from '../kit-studio.js';

const r = Router();
const canEditStudio = requireRole(...PLANNING_ROLES);
const canEdit = user => user?.role === 'admin' || PLANNING_ROLES.includes(user?.role);
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
    res.json({ ...state, me: { name: req.user?.name ?? null, can_edit: canEdit(req.user) } });
  } catch (e) {
    if (e?.code === MISSING_TABLE) return res.json({ kits: [], products: [], drafts: [], settings: null, me: { name: req.user?.name ?? null, can_edit: false }, missing: true });
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

async function recordRevision(kitId, before, after, user, note, qc) {
  await qc(`
    INSERT INTO fluence_master_revisions (kit_id, area, before, after, note, changed_by, changed_by_id, changed_from)
    VALUES ($1, 'components', $2::jsonb, $3::jsonb, $4, $5, $6, $7)`,
  [kitId, JSON.stringify(before), JSON.stringify(after), note, user.name, user.id ?? null, FROM]);
}

// Studio product ids → inner product ids. Every product the studio lists is in
// the inner product master, so an id that maps to nothing is a stale page.
async function innerIdsFor(pids, qc) {
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
    if (inner == null || !ok.has(inner)) throw fail(400, 'One of the kit\'s products is not in the Fluence inner product master any more — reload the page and pick it again.');
  }
  return out;
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

      const innerOf = await innerIdsFor(items.map(i => i.pid), qc);
      if (!fk) {
        // A kit designed in the studio becomes a Fluence kit when it is saved
        // as a kit: unlinked (no product yet) until someone links its carton
        // in the Fluence Master, like any other kit on the customer's list.
        const created = await oc(`
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

      const label = fk.product_code ? `${fk.product_code} ${fk.product_name}` : fk.kit_name;
      const componentsChanged = await writeComponents(fk.id, items, innerOf, req.user, label, qc);
      const saved = await upsertKitRow(id, fk.id, row, req.user, qc);
      const erp = await writeErpSize(fk, saved[0], req.user, qc);
      return { version: saved[0].version, componentsChanged, ...erp };
    });
    res.json({ id, ...outcome, doc: await composeOne('kits', id) });
  } catch (e) { next(e); }
});

// "Use in ERP": replace the kit carton's product size with the studio's
// CONFIRMED size. Only ever a deliberate click — a save never does this.
r.post('/kit-studio/kits/:id/erp-size', canEditStudio, async (req, res, next) => {
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
        if (fk.product_id) throw fail(409, 'This kit is linked to an ERP product. Unlink it in the Fluence Master before deleting it here.');
        const rx = await oc('SELECT id FROM fluence_prescriptions WHERE kit_id = $1', [fk.id]);
        if (rx) throw fail(409, 'This kit has a prescription in the Fluence master — it can only be retired there.');
        await qc('DELETE FROM fluence_kits WHERE id = $1', [fk.id]);
        await audit('fluence_kit', fk.id, 'delete', `${row.name} — deleted in Kit Studio (never linked to a product)`, qc, req.user.name);
      }
      await qc('DELETE FROM kit_studio_kits WHERE id = $1', [id]);
    });
    res.json({ id, deleted: true });
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
      return saved.version;
    });
    res.json({ id, version });
  } catch (e) { next(e); }
});

r.delete('/kit-studio/drafts/:id', canEditStudio, async (req, res, next) => {
  try {
    await q('DELETE FROM kit_studio_drafts WHERE id = $1', [req.params.id]);
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
      return saved.version;
    });
    res.json({ id: 'main', version });
  } catch (e) { next(e); }
});

export { compose as composeKitStudioState };
export default r;
