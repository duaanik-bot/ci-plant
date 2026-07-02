// Procurement — PR → PO → GRN → QC → stock. Every hand-off is real:
// convert creates an actual PO row, QC acceptance actually releases stock.
import { Router } from 'express';
import db from '../db.js';
import { audit, nextNumber } from '../helpers.js';

const r = Router();

// ── Requisitions ────────────────────────────────────────────────────────────
r.get('/requisitions', (req, res) => {
  res.json(db.prepare(`
    SELECT pr.*, m.name AS material_name, m.unit, po.po_number
    FROM requisitions pr JOIN materials m ON m.id=pr.material_id
    LEFT JOIN purchase_orders po ON po.requisition_id=pr.id
    ORDER BY pr.id DESC`).all());
});

r.post('/requisitions', (req, res, next) => {
  try {
    const { material_id, qty, needed_by, reason } = req.body;
    if (!material_id || !qty) return res.status(400).json({ error: 'Material and quantity are required' });
    const pr_number = nextNumber('CI-PR-', 'requisitions', 'pr_number');
    const info = db.prepare(
      'INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason) VALUES (?,?,?,?,?)'
    ).run(pr_number, material_id, qty, needed_by || null, reason || null);
    audit('requisition', info.lastInsertRowid, 'create', pr_number);
    res.json(db.prepare('SELECT * FROM requisitions WHERE id=?').get(info.lastInsertRowid));
  } catch (e) { next(e); }
});

r.post('/requisitions/:id/approve', (req, res, next) => {
  try {
    const pr = db.prepare('SELECT * FROM requisitions WHERE id=?').get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending') return res.status(409).json({ error: `Cannot approve a ${pr.status} requisition` });
    db.prepare(`UPDATE requisitions SET status='approved' WHERE id=?`).run(pr.id);
    audit('requisition', pr.id, 'approve');
    res.json({ ...pr, status: 'approved' });
  } catch (e) { next(e); }
});

r.post('/requisitions/:id/reject', (req, res, next) => {
  try {
    const pr = db.prepare('SELECT * FROM requisitions WHERE id=?').get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending') return res.status(409).json({ error: `Cannot reject a ${pr.status} requisition` });
    db.prepare(`UPDATE requisitions SET status='rejected' WHERE id=?`).run(pr.id);
    audit('requisition', pr.id, 'reject');
    res.json({ ...pr, status: 'rejected' });
  } catch (e) { next(e); }
});

// Convert PR → PO. Guarded: PR must be approved. Creates a REAL PO + line.
r.post('/requisitions/:id/convert', (req, res, next) => {
  try {
    const { vendor_id, rate } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
    const poId = db.transaction(() => {
      const pr = db.prepare('SELECT * FROM requisitions WHERE id=?').get(req.params.id);
      if (!pr) throw Object.assign(new Error('Requisition not found'), { status: 404 });
      if (pr.status !== 'approved')
        throw Object.assign(new Error('Requisition must be approved before conversion'), { status: 409 });
      const po_number = nextNumber('CI-VPO-', 'purchase_orders', 'po_number');
      const info = db.prepare(
        'INSERT INTO purchase_orders (po_number, vendor_id, requisition_id) VALUES (?,?,?)'
      ).run(po_number, vendor_id, pr.id);
      db.prepare('INSERT INTO po_lines (purchase_order_id, material_id, qty, rate) VALUES (?,?,?,?)')
        .run(info.lastInsertRowid, pr.material_id, pr.qty, rate || 0);
      db.prepare(`UPDATE requisitions SET status='converted' WHERE id=?`).run(pr.id);
      audit('purchase_order', info.lastInsertRowid, 'create_from_pr', po_number);
      return info.lastInsertRowid;
    })();
    res.json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId));
  } catch (e) { next(e); }
});

// ── Purchase Orders ─────────────────────────────────────────────────────────
r.get('/purchase-orders', (req, res) => {
  const pos = db.prepare(`
    SELECT po.*, v.name AS vendor_name, pr.pr_number
    FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id
    LEFT JOIN requisitions pr ON pr.id=po.requisition_id
    ORDER BY po.id DESC`).all();
  const lines = db.prepare(`
    SELECT pl.*, m.name AS material_name, m.unit FROM po_lines pl
    JOIN materials m ON m.id=pl.material_id`).all();
  const byPo = {};
  for (const l of lines) (byPo[l.purchase_order_id] ||= []).push(l);
  res.json(pos.map(po => ({ ...po, lines: byPo[po.id] || [] })));
});

r.post('/purchase-orders', (req, res, next) => {
  try {
    const { vendor_id, lines } = req.body;
    if (!vendor_id || !lines?.length) return res.status(400).json({ error: 'Vendor and at least one line are required' });
    const poId = db.transaction(() => {
      const po_number = nextNumber('CI-VPO-', 'purchase_orders', 'po_number');
      const info = db.prepare('INSERT INTO purchase_orders (po_number, vendor_id) VALUES (?,?)').run(po_number, vendor_id);
      const ins = db.prepare('INSERT INTO po_lines (purchase_order_id, material_id, qty, rate) VALUES (?,?,?,?)');
      for (const l of lines) ins.run(info.lastInsertRowid, l.material_id, l.qty, l.rate || 0);
      audit('purchase_order', info.lastInsertRowid, 'create', po_number);
      return info.lastInsertRowid;
    })();
    res.json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId));
  } catch (e) { next(e); }
});

// ── GRN + QC ────────────────────────────────────────────────────────────────
r.get('/grns', (req, res) => {
  res.json(db.prepare(`
    SELECT g.*, m.name AS material_name, m.unit, po.po_number, v.name AS vendor_name
    FROM grns g JOIN materials m ON m.id=g.material_id
    JOIN purchase_orders po ON po.id=g.purchase_order_id
    JOIN vendors v ON v.id=po.vendor_id
    ORDER BY g.id DESC`).all());
});

// Receive material against a PO line → quarantine batch + ledger row.
r.post('/grns', (req, res, next) => {
  try {
    const { po_line_id, qty, batch_no } = req.body;
    if (!po_line_id || !qty) return res.status(400).json({ error: 'PO line and quantity are required' });
    const grnId = db.transaction(() => {
      const pl = db.prepare('SELECT * FROM po_lines WHERE id=?').get(po_line_id);
      if (!pl) throw Object.assign(new Error('PO line not found'), { status: 404 });
      const unit = db.prepare('SELECT unit FROM materials WHERE id=?').get(pl.material_id).unit;
      const grn_number = nextNumber('CI-GRN-', 'grns', 'grn_number');
      const bno = batch_no || `${grn_number}-B1`;
      const g = db.prepare(
        `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no)
         VALUES (?,?,?,?,?,?)`
      ).run(grn_number, pl.purchase_order_id, pl.id, pl.material_id, qty, bno);
      const b = db.prepare(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id)
         VALUES (?,?,?,?,?,'quarantine',?)`
      ).run(pl.material_id, bno, qty, qty, unit, g.lastInsertRowid);
      db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(pl.material_id, b.lastInsertRowid, 'grn', qty, 'grn', g.lastInsertRowid, `GRN ${grn_number} (quarantine)`);
      audit('grn', g.lastInsertRowid, 'receive', grn_number);
      return g.lastInsertRowid;
    })();
    res.json(db.prepare('SELECT * FROM grns WHERE id=?').get(grnId));
  } catch (e) { next(e); }
});

// QC decision — acceptance releases the batch to available stock and updates
// the PO. Rejection marks the batch rejected. Both atomic.
r.post('/grns/:id/qc', (req, res, next) => {
  try {
    const { accept, note } = req.body;
    db.transaction(() => {
      const g = db.prepare('SELECT * FROM grns WHERE id=?').get(req.params.id);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (g.status !== 'quarantine') throw Object.assign(new Error('GRN already QC-decided'), { status: 409 });

      const batch = db.prepare('SELECT * FROM stock_batches WHERE grn_id=?').get(g.id);
      if (accept) {
        db.prepare(`UPDATE stock_batches SET status='available' WHERE id=?`).run(batch.id);
        db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(g.material_id, batch.id, 'qc_release', 0, 'grn', g.id, note || 'QC accepted — released to stock');
        db.prepare('UPDATE po_lines SET received_qty = received_qty + ? WHERE id=?').run(g.qty, g.po_line_id);
        // roll up PO status
        const lines = db.prepare('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=?').all(g.purchase_order_id);
        const full = lines.every(l => l.received_qty >= l.qty);
        const some = lines.some(l => l.received_qty > 0);
        db.prepare('UPDATE purchase_orders SET status=? WHERE id=?')
          .run(full ? 'received' : some ? 'partially_received' : 'open', g.purchase_order_id);
        db.prepare(`UPDATE grns SET status='accepted', qc_at=datetime('now','localtime'), qc_note=? WHERE id=?`).run(note || null, g.id);
      } else {
        db.prepare(`UPDATE stock_batches SET status='rejected' WHERE id=?`).run(batch.id);
        db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(g.material_id, batch.id, 'qc_reject', -g.qty, 'grn', g.id, note || 'QC rejected');
        db.prepare(`UPDATE grns SET status='rejected', qc_at=datetime('now','localtime'), qc_note=? WHERE id=?`).run(note || null, g.id);
      }
      audit('grn', g.id, accept ? 'qc_accept' : 'qc_reject', note);
    })();
    res.json(db.prepare('SELECT * FROM grns WHERE id=?').get(req.params.id));
  } catch (e) { next(e); }
});

export default r;
