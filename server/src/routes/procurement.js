// Procurement — PR → PO → GRN → QC → stock. Every hand-off is real.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canBuy = requireRole('planner');
const canQc = requireRole('qc');

// ── Requisitions ────────────────────────────────────────────────────────────
r.get('/requisitions', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT pr.*, m.name AS material_name, m.unit, po.po_number
      FROM requisitions pr JOIN materials m ON m.id=pr.material_id
      LEFT JOIN purchase_orders po ON po.requisition_id=pr.id
      ORDER BY pr.id DESC`));
  } catch (e) { next(e); }
});

r.post('/requisitions', canBuy, async (req, res, next) => {
  try {
    const { material_id, qty, needed_by, reason } = req.body;
    if (!material_id || !qty) return res.status(400).json({ error: 'Material and quantity are required' });
    const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number');
    const [pr] = await q(
      'INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [pr_number, material_id, qty, needed_by || null, reason || null]);
    await audit('requisition', pr.id, 'create', pr_number, q, req.user.name);
    res.json(pr);
  } catch (e) { next(e); }
});

for (const [action, from, to] of [['approve', 'pending', 'approved'], ['reject', 'pending', 'rejected']]) {
  r.post(`/requisitions/:id/${action}`, canBuy, async (req, res, next) => {
    try {
      const pr = await one('SELECT * FROM requisitions WHERE id=$1', [req.params.id]);
      if (!pr) return res.status(404).json({ error: 'Not found' });
      if (pr.status !== from) return res.status(409).json({ error: `Cannot ${action} a ${pr.status} requisition` });
      await q('UPDATE requisitions SET status=$1 WHERE id=$2', [to, pr.id]);
      await audit('requisition', pr.id, action, null, q, req.user.name);
      res.json({ ...pr, status: to });
    } catch (e) { next(e); }
  });
}

// Convert PR → PO. Guarded: PR must be approved. Creates a REAL PO + line.
r.post('/requisitions/:id/convert', canBuy, async (req, res, next) => {
  try {
    const { vendor_id, rate } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
    const poId = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Requisition not found'), { status: 404 });
      if (pr.status !== 'approved')
        throw Object.assign(new Error('Requisition must be approved before conversion'), { status: 409 });
      const po_number = await nextNumber('CI-VPO-', 'purchase_orders', 'po_number', oc);
      const [po] = await qc(
        'INSERT INTO purchase_orders (po_number, vendor_id, requisition_id) VALUES ($1,$2,$3) RETURNING id',
        [po_number, vendor_id, pr.id]);
      await qc('INSERT INTO po_lines (purchase_order_id, material_id, qty, rate) VALUES ($1,$2,$3,$4)',
        [po.id, pr.material_id, pr.qty, rate || 0]);
      await qc(`UPDATE requisitions SET status='converted' WHERE id=$1`, [pr.id]);
      await audit('purchase_order', po.id, 'create_from_pr', po_number, qc, req.user.name);
      return po.id;
    });
    res.json(await one('SELECT * FROM purchase_orders WHERE id=$1', [poId]));
  } catch (e) { next(e); }
});

// ── Purchase Orders ─────────────────────────────────────────────────────────
r.get('/purchase-orders', async (_req, res, next) => {
  try {
    const pos = await q(`
      SELECT po.*, v.name AS vendor_name, pr.pr_number
      FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id
      LEFT JOIN requisitions pr ON pr.id=po.requisition_id
      ORDER BY po.id DESC`);
    const lines = await q(`
      SELECT pl.*, m.name AS material_name, m.unit FROM po_lines pl
      JOIN materials m ON m.id=pl.material_id`);
    const byPo = {};
    for (const l of lines) (byPo[l.purchase_order_id] ||= []).push(l);
    res.json(pos.map(po => ({ ...po, lines: byPo[po.id] || [] })));
  } catch (e) { next(e); }
});

r.get('/purchase-orders/:id', async (req, res, next) => {
  try {
    const po = await one(`
      SELECT po.*, v.name AS vendor_name, v.city AS vendor_city, v.contact AS vendor_contact,
             v.phone AS vendor_phone, pr.pr_number
      FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id
      LEFT JOIN requisitions pr ON pr.id=po.requisition_id
      WHERE po.id=$1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    po.lines = await q(`
      SELECT pl.*, m.name AS material_name, m.spec, m.unit FROM po_lines pl
      JOIN materials m ON m.id=pl.material_id WHERE pl.purchase_order_id=$1`, [po.id]);
    res.json(po);
  } catch (e) { next(e); }
});

r.post('/purchase-orders', canBuy, async (req, res, next) => {
  try {
    const { vendor_id, lines } = req.body;
    if (!vendor_id || !lines?.length) return res.status(400).json({ error: 'Vendor and at least one line are required' });
    const poId = await tx(async (qc, oc) => {
      const po_number = await nextNumber('CI-VPO-', 'purchase_orders', 'po_number', oc);
      const [po] = await qc('INSERT INTO purchase_orders (po_number, vendor_id) VALUES ($1,$2) RETURNING id', [po_number, vendor_id]);
      for (const l of lines) {
        await qc('INSERT INTO po_lines (purchase_order_id, material_id, qty, rate) VALUES ($1,$2,$3,$4)',
          [po.id, l.material_id, l.qty, l.rate || 0]);
      }
      await audit('purchase_order', po.id, 'create', po_number, qc, req.user.name);
      return po.id;
    });
    res.json(await one('SELECT * FROM purchase_orders WHERE id=$1', [poId]));
  } catch (e) { next(e); }
});

// ── GRN + QC ────────────────────────────────────────────────────────────────
r.get('/grns', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT g.*, m.name AS material_name, m.unit, po.po_number, v.name AS vendor_name
      FROM grns g JOIN materials m ON m.id=g.material_id
      JOIN purchase_orders po ON po.id=g.purchase_order_id
      JOIN vendors v ON v.id=po.vendor_id
      ORDER BY g.id DESC`));
  } catch (e) { next(e); }
});

// Receive material against a PO line → quarantine batch + ledger row.
r.post('/grns', canBuy, async (req, res, next) => {
  try {
    const { po_line_id, qty, batch_no } = req.body;
    if (!po_line_id || !qty) return res.status(400).json({ error: 'PO line and quantity are required' });
    const grnId = await tx(async (qc, oc) => {
      const pl = await oc('SELECT * FROM po_lines WHERE id=$1', [po_line_id]);
      if (!pl) throw Object.assign(new Error('PO line not found'), { status: 404 });
      const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [pl.material_id])).unit;
      const grn_number = await nextNumber('CI-GRN-', 'grns', 'grn_number', oc);
      const bno = batch_no || `${grn_number}-B1`;
      const [g] = await qc(
        `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [grn_number, pl.purchase_order_id, pl.id, pl.material_id, qty, bno]);
      const [b] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id)
         VALUES ($1,$2,$3,$3,$4,'quarantine',$5) RETURNING id`,
        [pl.material_id, bno, qty, unit, g.id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
        [pl.material_id, b.id, qty, g.id, `GRN ${grn_number} (quarantine)`]);
      await audit('grn', g.id, 'receive', grn_number, qc, req.user.name);
      return g.id;
    });
    res.json(await one('SELECT * FROM grns WHERE id=$1', [grnId]));
  } catch (e) { next(e); }
});

// QC decision — acceptance releases the batch to stock and updates the PO.
r.post('/grns/:id/qc', canQc, async (req, res, next) => {
  try {
    const { accept, note } = req.body;
    await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (g.status !== 'quarantine') throw Object.assign(new Error('GRN already QC-decided'), { status: 409 });

      const batch = await oc('SELECT * FROM stock_batches WHERE grn_id=$1', [g.id]);
      if (accept) {
        await qc(`UPDATE stock_batches SET status='available' WHERE id=$1`, [batch.id]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'qc_release',0,'grn',$3,$4)`,
          [g.material_id, batch.id, g.id, note || 'QC accepted — released to stock']);
        await qc('UPDATE po_lines SET received_qty = received_qty + $1 WHERE id=$2', [g.qty, g.po_line_id]);
        const lines = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1', [g.purchase_order_id]);
        const full = lines.every(l => l.received_qty >= l.qty);
        const some = lines.some(l => l.received_qty > 0);
        await qc('UPDATE purchase_orders SET status=$1 WHERE id=$2',
          [full ? 'received' : some ? 'partially_received' : 'open', g.purchase_order_id]);
        await qc(`UPDATE grns SET status='accepted', qc_at=now(), qc_note=$1 WHERE id=$2`, [note || null, g.id]);
      } else {
        await qc(`UPDATE stock_batches SET status='rejected' WHERE id=$1`, [batch.id]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'qc_reject',$3,'grn',$4,$5)`,
          [g.material_id, batch.id, -g.qty, g.id, note || 'QC rejected']);
        await qc(`UPDATE grns SET status='rejected', qc_at=now(), qc_note=$1 WHERE id=$2`, [note || null, g.id]);
      }
      await audit('grn', g.id, accept ? 'qc_accept' : 'qc_reject', note, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM grns WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

export default r;
