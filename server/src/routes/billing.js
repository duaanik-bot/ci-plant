// Billing — the Pureflix accounts spine, adapted for the plant.
// Invoices are cut from dispatched (challan) lines, GST splits by place of
// supply, payments knock invoices off, and the ledger shows who owes what.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canBill = requireRole('planner'); // admin implied

// Colour Impressions, Patiala — place of supply logic reads this.
export const COMPANY = {
  name: 'Colour Impressions',
  address: 'Focal Point, Patiala, Punjab 147004',
  gstin: '03AABCC1234D1Z5',
  state: 'Punjab',
  hsn: '48192010', // folding cartons of non-corrugated paperboard
  gst_rate: 18,
};

// Dispatch lines that haven't been invoiced yet, grouped by customer.
r.get('/billing/uninvoiced', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT dl.id AS dispatch_line_id, dl.qty, d.challan_number, d.dispatched_at,
             o.po_number, c.id AS customer_id, c.name AS customer_name, c.state, c.gstin,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             ol.rate, dl.qty * ol.rate AS amount
      FROM dispatch_lines dl
      JOIN dispatches d ON d.id = dl.dispatch_id
      JOIN orders o ON o.id = d.order_id
      JOIN customers c ON c.id = d.customer_id
      JOIN order_lines ol ON ol.id = dl.order_line_id
      JOIN products p ON p.id = dl.product_id
      LEFT JOIN invoice_lines il ON il.dispatch_line_id = dl.id
      WHERE il.id IS NULL
      ORDER BY c.name, d.id`));
  } catch (e) { next(e); }
});

r.get('/invoices', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT i.*, c.name AS customer_name, c.state, c.gstin,
        (SELECT COUNT(*)::int FROM invoice_lines il WHERE il.invoice_id=i.id) AS line_count,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id=i.id),0) AS paid
      FROM invoices i JOIN customers c ON c.id=i.customer_id
      ORDER BY i.id DESC`));
  } catch (e) { next(e); }
});

r.get('/invoices/:id', async (req, res, next) => {
  try {
    const inv = await one(`
      SELECT i.*, c.name AS customer_name, c.city, c.state, c.gstin, c.contact, c.phone,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id=i.id),0) AS paid
      FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    inv.lines = await q(`
      SELECT il.*, p.name AS product_name, p.code AS product_code, p.size,
             d.challan_number, o.po_number
      FROM invoice_lines il
      JOIN products p ON p.id = il.product_id
      JOIN dispatch_lines dl ON dl.id = il.dispatch_line_id
      JOIN dispatches d ON d.id = dl.dispatch_id
      JOIN orders o ON o.id = d.order_id
      WHERE il.invoice_id=$1 ORDER BY il.id`, [inv.id]);
    inv.payments = await q('SELECT * FROM payments WHERE invoice_id=$1 ORDER BY id', [inv.id]);
    inv.company = COMPANY;
    res.json(inv);
  } catch (e) { next(e); }
});

// Cut an invoice from uninvoiced dispatch lines of one customer.
r.post('/invoices', canBill, async (req, res, next) => {
  try {
    const { customer_id, dispatch_line_ids, invoice_date, notes } = req.body;
    if (!customer_id || !dispatch_line_ids?.length) {
      return res.status(400).json({ error: 'Customer and at least one dispatch line are required' });
    }
    const invId = await tx(async (qc, oc) => {
      const customer = await oc('SELECT * FROM customers WHERE id=$1', [customer_id]);
      if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

      let subtotal = 0;
      const lines = [];
      for (const dlId of dispatch_line_ids) {
        const row = await oc(`
          SELECT dl.id, dl.qty, dl.product_id, d.customer_id, ol.rate,
                 (SELECT COUNT(*)::int FROM invoice_lines il WHERE il.dispatch_line_id=dl.id) AS invoiced
          FROM dispatch_lines dl
          JOIN dispatches d ON d.id = dl.dispatch_id
          JOIN order_lines ol ON ol.id = dl.order_line_id
          WHERE dl.id=$1 FOR UPDATE OF dl`, [dlId]);
        if (!row) throw Object.assign(new Error(`Dispatch line ${dlId} not found`), { status: 404 });
        if (row.customer_id !== customer.id)
          throw Object.assign(new Error('All lines must belong to the same customer'), { status: 409 });
        if (row.invoiced > 0)
          throw Object.assign(new Error('A selected line is already invoiced'), { status: 409 });
        const amount = +(row.qty * row.rate).toFixed(2);
        subtotal += amount;
        lines.push({ ...row, amount });
      }
      subtotal = +subtotal.toFixed(2);

      // Place of supply: same state → CGST+SGST, otherwise IGST.
      const intra = (customer.state || '').trim().toLowerCase() === COMPANY.state.toLowerCase();
      const half = +(subtotal * COMPANY.gst_rate / 200).toFixed(2);
      const cgst = intra ? half : 0;
      const sgst = intra ? half : 0;
      const igst = intra ? 0 : +(subtotal * COMPANY.gst_rate / 100).toFixed(2);
      const gross = subtotal + cgst + sgst + igst;
      const total = Math.round(gross);
      const round_off = +(total - gross).toFixed(2);

      const invoice_number = await nextNumber('CI-INV-', 'invoices', 'invoice_number', oc);
      const [inv] = await qc(`
        INSERT INTO invoices (invoice_number, customer_id, invoice_date, subtotal, cgst, sgst, igst, round_off, total, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [invoice_number, customer.id, invoice_date || new Date().toISOString().slice(0, 10),
         subtotal, cgst, sgst, igst, round_off, total, notes || null]);
      for (const l of lines) {
        await qc('INSERT INTO invoice_lines (invoice_id, dispatch_line_id, product_id, qty, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)',
          [inv.id, l.id, l.product_id, l.qty, l.rate, l.amount]);
      }
      await audit('invoice', inv.id, 'create', `${invoice_number} ₹${total}`, qc, req.user.name);
      return inv.id;
    });
    res.json(await one('SELECT * FROM invoices WHERE id=$1', [invId]));
  } catch (e) { next(e); }
});

// ── Payments ────────────────────────────────────────────────────────────────
r.get('/payments', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT p.*, c.name AS customer_name, i.invoice_number
      FROM payments p JOIN customers c ON c.id=p.customer_id
      LEFT JOIN invoices i ON i.id=p.invoice_id
      ORDER BY p.id DESC`));
  } catch (e) { next(e); }
});

r.post('/payments', canBill, async (req, res, next) => {
  try {
    const { customer_id, invoice_id, amount, mode, reference, notes } = req.body;
    if (!customer_id || !amount || +amount <= 0) {
      return res.status(400).json({ error: 'Customer and a positive amount are required' });
    }
    const payId = await tx(async (qc, oc) => {
      if (invoice_id) {
        const inv = await oc('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoice_id]);
        if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
        if (inv.customer_id !== +customer_id)
          throw Object.assign(new Error('Invoice belongs to a different customer'), { status: 409 });
        if (inv.status === 'cancelled')
          throw Object.assign(new Error('Cannot pay a cancelled invoice'), { status: 409 });
        const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id=$1', [invoice_id]);
        if (paid.s + +amount > inv.total + 0.01)
          throw Object.assign(new Error(`Payment exceeds balance (₹${(inv.total - paid.s).toFixed(2)} due)`), { status: 409 });
      }
      const payment_number = await nextNumber('CI-RCPT-', 'payments', 'payment_number', oc);
      const [p] = await qc(`
        INSERT INTO payments (payment_number, customer_id, invoice_id, amount, mode, reference, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [payment_number, customer_id, invoice_id || null, amount, mode || 'neft', reference || null, notes || null]);
      if (invoice_id) {
        const inv = await oc('SELECT total FROM invoices WHERE id=$1', [invoice_id]);
        const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id=$1', [invoice_id]);
        if (paid.s >= inv.total - 0.01) await qc(`UPDATE invoices SET status='paid' WHERE id=$1`, [invoice_id]);
      }
      await audit('payment', p.id, 'receive', `${payment_number} ₹${amount}`, qc, req.user.name);
      return p.id;
    });
    res.json(await one('SELECT * FROM payments WHERE id=$1', [payId]));
  } catch (e) { next(e); }
});

// ── Outstanding ledger with aging ───────────────────────────────────────────
r.get('/accounts/outstanding', async (_req, res, next) => {
  try {
    const invoices = await q(`
      SELECT i.id, i.customer_id, i.invoice_number, i.invoice_date, i.total, i.status,
             c.name AS customer_name, c.city, c.state,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id=i.id),0) AS paid
      FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status != 'cancelled'
      ORDER BY i.customer_id, i.invoice_date`);
    const onAccount = await q(`
      SELECT customer_id, COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id IS NULL GROUP BY customer_id`);
    const onAcctBy = Object.fromEntries(onAccount.map(x => [x.customer_id, x.s]));

    const byCust = {};
    const now = Date.now();
    for (const inv of invoices) {
      const c = (byCust[inv.customer_id] ||= {
        customer_id: inv.customer_id, customer_name: inv.customer_name, city: inv.city,
        invoiced: 0, paid: 0, on_account: onAcctBy[inv.customer_id] || 0,
        b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0, open_invoices: 0,
      });
      c.invoiced += inv.total;
      c.paid += inv.paid;
      const due = inv.total - inv.paid;
      if (due > 0.01) {
        c.open_invoices += 1;
        const days = Math.floor((now - new Date(inv.invoice_date).getTime()) / 864e5);
        if (days <= 30) c.b0_30 += due;
        else if (days <= 60) c.b31_60 += due;
        else if (days <= 90) c.b61_90 += due;
        else c.b90p += due;
      }
    }
    res.json(Object.values(byCust)
      .map(c => ({ ...c, outstanding: +(c.invoiced - c.paid - c.on_account).toFixed(2) }))
      .sort((a, b) => b.outstanding - a.outstanding));
  } catch (e) { next(e); }
});

// ── Sales insights ──────────────────────────────────────────────────────────
r.get('/reports/insights', async (_req, res, next) => {
  try {
    const monthly = await q(`
      SELECT to_char(d.dispatched_at,'YYYY-MM') AS month,
             COALESCE(SUM(dl.qty*ol.rate),0) AS dispatched_value,
             COALESCE(SUM(dl.qty),0)::int AS cartons
      FROM dispatch_lines dl
      JOIN dispatches d ON d.id=dl.dispatch_id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      WHERE d.dispatched_at > current_date - interval '6 months'
      GROUP BY 1 ORDER BY 1`);
    const topCustomers = await q(`
      SELECT c.name, c.segment,
             COALESCE(SUM(dl.qty*ol.rate),0) AS value, COALESCE(SUM(dl.qty),0)::int AS cartons
      FROM dispatch_lines dl
      JOIN dispatches d ON d.id=dl.dispatch_id
      JOIN customers c ON c.id=d.customer_id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      GROUP BY c.id ORDER BY value DESC LIMIT 8`);
    const topProducts = await q(`
      SELECT p.name, p.code,
             COALESCE(SUM(dl.qty*ol.rate),0) AS value, COALESCE(SUM(dl.qty),0)::int AS cartons
      FROM dispatch_lines dl
      JOIN products p ON p.id=dl.product_id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      GROUP BY p.id ORDER BY value DESC LIMIT 8`);
    const receivables = await one(`
      SELECT COALESCE(SUM(i.total),0) AS invoiced,
             COALESCE((SELECT SUM(amount) FROM payments),0) AS collected
      FROM invoices i WHERE i.status != 'cancelled'`);
    res.json({
      monthly, top_customers: topCustomers, top_products: topProducts,
      receivables: { ...receivables, outstanding: +(receivables.invoiced - receivables.collected).toFixed(2) },
    });
  } catch (e) { next(e); }
});

export default r;
