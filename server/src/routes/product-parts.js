// "Made in parts" on the Product Master — the list of parts an outer carton is
// printed as (carton-parts.js). Saving it re-syncs every open order line of the
// carton, so a PO already booked before the parts were set up converts itself.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';
import { lineSays, partsSetError } from '../carton-parts.js';
import { syncPartLines } from '../carton-parts-db.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied — same as masters.js

const PARTS_OF = `
  SELECT pp.id, pp.part_product_id, pp.label, pp.per_carton, pp.seq,
         p.code, p.name, p.board_name, p.gsm, p.child_l, p.child_w, p.ups, p.die_number
    FROM product_parts pp JOIN products p ON p.id = pp.part_product_id
   WHERE pp.outer_product_id = $1 ORDER BY pp.seq, pp.id`;

// An id Postgres can take as an integer. Anything else (a blank pick, NaN, 1.5)
// never reaches a query — the int cast would answer it with a 500; partsSetError
// answers it with a 400 that names the row.
const isId = v => Number.isInteger(v) && v > 0 && v <= 2147483647;
const notFound = () => Object.assign(new Error('Product not found'), { status: 404 });

r.get('/products/:id/parts', async (req, res, next) => {
  try {
    const id = +req.params.id;
    if (!isId(id)) throw notFound();
    const partOf = await q(`
      SELECT op.id, op.code, op.name FROM product_parts pp JOIN products op ON op.id = pp.outer_product_id
       WHERE pp.part_product_id = $1 ORDER BY op.code`, [id]);
    res.json({ parts: await q(PARTS_OF, [id]), part_of: partOf });
  } catch (e) { next(e); }
});

r.put('/products/:id/parts', canEdit, async (req, res, next) => {
  try {
    const outerId = +req.params.id;
    if (!isId(outerId)) throw notFound();
    // Clearing is `parts: []`, said out loud — a body without the list is a
    // broken request, never "no longer made in parts".
    if (!Array.isArray(req.body?.parts)) {
      throw Object.assign(new Error('Send the parts list — an empty list makes it a normal carton again'), { status: 400 });
    }
    const parts = req.body.parts.map((p, i) => ({
      part_product_id: Number(p?.part_product_id), label: String(p?.label || '').trim(),
      per_carton: Number(p?.per_carton ?? 1), seq: i + 1,
    }));
    const result = await tx(async (qc, oc) => {
      // One writer at a time for EVERY parts list: the one-level rule reads other
      // cartons' lists, so two saves at once (X gets part P while P gets parts of
      // its own) could each pass it. Tiny table, rare writes — a global lock is fine.
      await qc(`SELECT pg_advisory_xact_lock(hashtext('product_parts'))`);
      // KEY SHARE: enough to stop the product being deleted or moved to another
      // customer mid-save; anything stronger deadlocks against plan-save and
      // artwork approval, which lock a line and then update this product row.
      const outer = await oc('SELECT id, customer_id, code FROM products WHERE id=$1 FOR KEY SHARE', [outerId]);
      if (!outer) throw notFound();
      const ids = parts.map(p => p.part_product_id).filter(isId);
      // The parts too, in id order: a customer move of a part (masters.js
      // partsMoveBlock) either waits for this save and then sees the part, or
      // lands first and this read sees its new customer.
      const products = new Map((ids.length
        ? await qc('SELECT id, customer_id, code FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR KEY SHARE', [ids]) : [])
        .map(p => [p.id, p]));
      const outerIsPart = !!(await oc('SELECT 1 AS x FROM product_parts WHERE part_product_id=$1 LIMIT 1', [outerId]));
      const partsWithParts = ids.length
        ? (await qc('SELECT DISTINCT outer_product_id AS id FROM product_parts WHERE outer_product_id = ANY($1::int[])', [ids])).map(x => x.id)
        : [];
      const err = partsSetError({ outer, parts, products, outerIsPart, partsWithParts });
      if (err) throw Object.assign(new Error(err), { status: 400 });

      // The same list saved again rewrites nothing and adds nothing to the
      // history (a normal carton "saved" empty never reads "no longer made in
      // parts"); it still re-syncs the open lines below — the way to retry a
      // line that could not follow last time (it was in a gang, say).
      const before = await qc(`SELECT part_product_id, label, per_carton FROM product_parts
                                WHERE outer_product_id=$1 ORDER BY seq, id`, [outerId]);
      const unchanged = before.length === parts.length && before.every((b, i) =>
        b.part_product_id === parts[i].part_product_id && b.label === parts[i].label && b.per_carton === parts[i].per_carton);
      if (!unchanged) {
        await qc('DELETE FROM product_parts WHERE outer_product_id=$1', [outerId]);
        for (const p of parts) {
          await qc(`INSERT INTO product_parts (outer_product_id, part_product_id, label, per_carton, seq, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6)`,
            [outerId, p.part_product_id, p.label, p.per_carton, p.seq, req.user.name]);
        }
        await audit('product', outerId, 'parts_saved',
          parts.length
            ? parts.map(p => `${p.label} ${products.get(p.part_product_id).code} ×${p.per_carton}`).join(' + ')
            : 'no longer made in parts', qc, req.user.name);
      }

      // Every open line of this carton follows — including lines booked before
      // the parts existed (the PO 02545 shape). Each line's ORDER is share-locked
      // before the line: an order edit, cancel or delete holds its order FOR
      // UPDATE and then takes its lines, and a part line inserted here checks
      // its order's key. Carton line first would cross them — this save holding
      // the carton line and waiting on the order, the edit holding the order and
      // waiting on the carton line (maybeCreateAssemblyCard's order, too).
      // One order's lines together, orders in id order — the order every
      // multi-order lock takes them in.
      const warnings = [];
      let synced = 0;
      // A PO can carry the carton twice (two batches): qty and batch tell which.
      const which = l => [Math.round(+l.qty || 0).toLocaleString('en-IN'), l.line_remark].filter(Boolean).join(' · ');
      const lines = await qc(`
        SELECT ol.id, ol.order_id, ol.qty, ol.line_remark, o.po_number
          FROM order_lines ol JOIN orders o ON o.id = ol.order_id
         WHERE ol.product_id=$1 AND ol.part_of_line_id IS NULL AND ol.status IN ('pending','planned')
         ORDER BY ol.order_id, ol.id`, [outerId]);
      for (const l of lines) {
        await oc('SELECT id FROM orders WHERE id=$1 FOR KEY SHARE', [l.order_id]);
        const s = await syncPartLines(l.id, qc, oc, req.user.name);
        synced += s.inserted + s.updated + s.removed;
        warnings.push(...s.warnings.map(w => `PO ${l.po_number} (${which(l)}): ${w}`));
      }
      // A line already past planning is never synced above: it runs as one carton
      // this time (carton-parts.js C2). Said, never refused — and only when a list
      // is saved, since clearing one converts nothing. A line that already has
      // part lines is a carton in parts already, so it is not named. Read only:
      // nothing here is written, so nothing here is locked.
      if (parts.length) {
        const passed = await qc(`
          SELECT ol.qty, ol.line_remark, ol.status, o.po_number
            FROM order_lines ol JOIN orders o ON o.id = ol.order_id
           WHERE ol.product_id=$1 AND ol.part_of_line_id IS NULL AND ol.status IN ('ready','in_production')
             AND NOT EXISTS (SELECT 1 FROM order_lines x WHERE x.part_of_line_id = ol.id)
           ORDER BY ol.order_id, ol.id`, [outerId]);
        for (const l of passed) {
          warnings.push(`PO ${l.po_number} (${which(l)}): ${lineSays(l.status)} — it runs as one carton this time`);
        }
      }
      return { synced, warnings };
    });
    res.json({ parts: await q(PARTS_OF, [outerId]), ...result });
  } catch (e) { next(e); }
});

export default r;
