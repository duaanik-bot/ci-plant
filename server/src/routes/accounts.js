// Accounts books — the buying side of the ledger, and the books that read both
// sides together.
//
//   Purchase bills   a vendor's bill. A line naming a trading item lands its
//                    quantity in stock (the inward twin of the direct invoice);
//                    a line with no item is value only.
//   Vendor payments  money paid out, against a bill or on account.
//   Payables         what each vendor is owed, aged.
//   Party ledger     one running statement per customer or vendor.
//   Cash & bank book every rupee in (customer receipts) and out (vendor
//                    payments), by mode, with a running balance.
//
// Customer invoices and receipts stay where they are (billing.js). Nothing
// here is read by procurement, planning or production.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { plantDateStr } from '../plant-calendar.js';
import { audit, nextNumber, lockDocNumber, moveBatchLevel, optionalText } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canBook = requireRole('planner'); // admin implied — same right as billing

const BILL_PREFIX = 'CI-PB-';
const PAY_PREFIX = 'CI-PAY-';
const REF = 'purchase_bill';
const MODES = ['neft', 'rtgs', 'upi', 'cheque', 'cash'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = v => (Number.isFinite(+v) ? +v : NaN);
const r2 = n => +(+n).toFixed(2);
// payments.received_at is a timestamp; every book here is kept by plant day.
const RECEIPT_DAY = `(p.received_at AT TIME ZONE 'Asia/Kolkata')::date`;

// ── Purchase bills ──────────────────────────────────────────────────────────
r.get('/purchase-bills', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT b.*, v.name AS vendor_name, v.city,
        (SELECT COUNT(*)::int FROM purchase_bill_lines l WHERE l.bill_id=b.id) AS line_count,
        (SELECT STRING_AGG(l.description, ', ' ORDER BY l.id) FROM purchase_bill_lines l WHERE l.bill_id=b.id) AS items,
        COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp WHERE vp.purchase_bill_id=b.id),0) AS paid
      FROM purchase_bills b JOIN vendors v ON v.id=b.vendor_id
      ORDER BY b.id DESC`));
  } catch (e) { next(e); }
});

r.post('/purchase-bills', canBook, async (req, res, next) => {
  try {
    const { vendor_id, bill_date } = req.body;
    const raw = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!vendor_id || !raw.length) throw fail(400, 'A vendor and at least one line are required');

    const billId = await tx(async (qc, oc) => {
      await lockDocNumber(BILL_PREFIX, oc);
      const vendor = await oc('SELECT id, name FROM vendors WHERE id=$1', [vendor_id]);
      if (!vendor) throw fail(404, 'Vendor not found');

      const lines = [];
      let subtotal = 0, tax = 0;
      for (const [i, l] of raw.entries()) {
        const at = `Line ${i + 1}`;
        const qty = num(l.qty), rate = num(l.rate);
        const gst = l.gst_pct == null || l.gst_pct === '' ? 0 : num(l.gst_pct);
        if (!(qty > 0)) throw fail(400, `${at}: enter a quantity`);
        if (!(rate >= 0)) throw fail(400, `${at}: enter a rate`);
        if (!(gst >= 0)) throw fail(400, `${at}: GST % cannot be negative`);
        let material = null;
        if (l.material_id) {
          material = await oc('SELECT id, name, unit, category FROM materials WHERE id=$1', [l.material_id]);
          if (!material) throw fail(404, `${at}: item not found`);
          // Board comes in through a GRN, with its QC and its holds. Only
          // trading goods are received straight off a bill.
          if (material.category !== 'trading')
            throw fail(409, `${at}: ${material.name} is not a trading item — receive it through a GRN, and book its bill as a value-only line`);
        }
        const description = optionalText(l.description) || material?.name;
        if (!description) throw fail(400, `${at}: enter a description`);
        const amount = r2(qty * rate);
        subtotal += amount;
        tax += amount * gst / 100;
        lines.push({ material, description, unit: material?.unit || optionalText(l.unit), qty, rate, amount, gst });
      }
      subtotal = r2(subtotal); tax = r2(tax);
      const gross = subtotal + tax;
      const total = Math.round(gross);
      const bill_number = await nextNumber(BILL_PREFIX, 'purchase_bills', 'bill_number', oc);
      const [bill] = await qc(`
        INSERT INTO purchase_bills (bill_number, vendor_id, vendor_bill_no, bill_date, subtotal, tax, round_off, total, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [bill_number, vendor.id, optionalText(req.body.vendor_bill_no), bill_date || plantDateStr(),
         subtotal, tax, r2(total - gross), total, optionalText(req.body.notes), req.user.name]);

      for (const l of lines) {
        let batchId = null;
        if (l.material) {
          // The goods land as their own pile, named after the bill, so the
          // warehouse can see where every kilo came from.
          const [b] = await qc(
            `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
             VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
            [l.material.id, bill_number, l.qty, l.material.unit]);
          batchId = b.id;
          await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                    VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
            [l.material.id, b.id, l.qty, REF, bill.id, `Purchased on ${bill_number} from ${vendor.name}`]);
          await qc('UPDATE materials SET last_rate=$1 WHERE id=$2', [l.rate, l.material.id]);
        }
        await qc(`INSERT INTO purchase_bill_lines (bill_id, material_id, batch_id, description, unit, qty, rate, amount, gst_pct)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [bill.id, l.material?.id ?? null, batchId, l.description, l.unit, l.qty, l.rate, l.amount, l.gst]);
      }
      await audit('purchase_bill', bill.id, 'create', `${bill_number} ₹${total} — ${vendor.name}`, qc, req.user.name);
      return bill.id;
    });
    res.json(await one('SELECT * FROM purchase_bills WHERE id=$1', [billId]));
  } catch (e) { next(e); }
});

// Deleting a bill takes its goods back out of stock — so it is refused once
// any of them has been sold, and once any payment has been made against it.
r.delete('/purchase-bills/:id', canBook, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const bill = await oc('SELECT * FROM purchase_bills WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!bill) throw fail(404, 'Purchase bill not found');
      const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM vendor_payments WHERE purchase_bill_id=$1', [bill.id]);
      if (+paid.s > 0) throw fail(409, 'Payments are recorded against this bill — delete the payment first');
      const lines = await qc(
        'SELECT * FROM purchase_bill_lines WHERE bill_id=$1 AND batch_id IS NOT NULL ORDER BY material_id, batch_id', [bill.id]);
      for (const l of lines) {
        const b = await oc('SELECT qty FROM stock_batches WHERE id=$1 FOR UPDATE', [l.batch_id]);
        if (+(b?.qty || 0) + 1e-6 < +l.qty)
          throw fail(409, `${l.description}: only ${+(+b?.qty || 0).toFixed(3)} of the ${l.qty} ${l.unit || ''} bought on this bill is still in stock — the rest has been sold`);
        await moveBatchLevel(l.batch_id, l.material_id, -l.qty, qc, oc);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
          [l.material_id, l.batch_id, -l.qty, REF, bill.id, `Purchase bill ${bill.bill_number} deleted — goods taken back out`]);
      }
      await qc('DELETE FROM purchase_bill_lines WHERE bill_id=$1', [bill.id]);
      await qc('DELETE FROM purchase_bills WHERE id=$1', [bill.id]);
      await audit('purchase_bill', bill.id, 'delete', `${bill.bill_number} ₹${bill.total} deleted`, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Vendor payments ─────────────────────────────────────────────────────────
r.get('/vendor-payments', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT vp.*, v.name AS vendor_name, b.bill_number, b.vendor_bill_no
      FROM vendor_payments vp JOIN vendors v ON v.id=vp.vendor_id
      LEFT JOIN purchase_bills b ON b.id=vp.purchase_bill_id
      ORDER BY vp.id DESC`));
  } catch (e) { next(e); }
});

r.post('/vendor-payments', canBook, async (req, res, next) => {
  try {
    const { vendor_id, purchase_bill_id, mode } = req.body;
    const amount = num(req.body.amount);
    if (!vendor_id || !(amount > 0)) throw fail(400, 'Vendor and a positive amount are required');
    if (mode && !MODES.includes(mode)) throw fail(400, 'Unknown payment mode');
    const payId = await tx(async (qc, oc) => {
      await lockDocNumber(PAY_PREFIX, oc);
      if (!await oc('SELECT id FROM vendors WHERE id=$1', [vendor_id])) throw fail(404, 'Vendor not found');
      if (purchase_bill_id) {
        const bill = await oc('SELECT * FROM purchase_bills WHERE id=$1 FOR UPDATE', [purchase_bill_id]);
        if (!bill) throw fail(404, 'Purchase bill not found');
        if (bill.vendor_id !== +vendor_id) throw fail(409, 'That bill belongs to a different vendor');
        const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM vendor_payments WHERE purchase_bill_id=$1', [bill.id]);
        if (+paid.s + amount > bill.total + 0.01)
          throw fail(409, `Payment exceeds the balance (₹${(bill.total - paid.s).toFixed(2)} due on ${bill.bill_number})`);
      }
      const payment_number = await nextNumber(PAY_PREFIX, 'vendor_payments', 'payment_number', oc);
      const [p] = await qc(`
        INSERT INTO vendor_payments (payment_number, vendor_id, purchase_bill_id, amount, mode, reference, notes, paid_on, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [payment_number, vendor_id, purchase_bill_id || null, amount, mode || 'neft',
         optionalText(req.body.reference), optionalText(req.body.notes), req.body.paid_on || plantDateStr(), req.user.name]);
      await audit('vendor_payment', p.id, 'pay', `${payment_number} ₹${amount}`, qc, req.user.name);
      return p.id;
    });
    res.json(await one('SELECT * FROM vendor_payments WHERE id=$1', [payId]));
  } catch (e) { next(e); }
});

r.delete('/vendor-payments/:id', canBook, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const p = await oc('SELECT * FROM vendor_payments WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!p) throw fail(404, 'Payment not found');
      await qc('DELETE FROM vendor_payments WHERE id=$1', [p.id]);
      await audit('vendor_payment', p.id, 'delete', `${p.payment_number} ₹${p.amount} deleted`, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// A customer receipt entered by mistake. The invoice it settled goes back to
// open, so it shows as outstanding again.
r.delete('/payments/:id', canBook, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const p = await oc('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!p) throw fail(404, 'Receipt not found');
      if (p.invoice_id) await oc('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [p.invoice_id]);
      await qc('DELETE FROM payments WHERE id=$1', [p.id]);
      if (p.invoice_id) await qc(`UPDATE invoices SET status='open' WHERE id=$1 AND status='paid'`, [p.invoice_id]);
      await audit('payment', p.id, 'delete', `${p.payment_number} ₹${p.amount} deleted`, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Payables — what each vendor is owed, aged from the bill date ────────────
r.get('/accounts/payables', async (_req, res, next) => {
  try {
    const bills = await q(`
      SELECT b.id, b.vendor_id, b.bill_date, b.total, v.name AS vendor_name, v.city,
             COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp WHERE vp.purchase_bill_id=b.id),0) AS paid
      FROM purchase_bills b JOIN vendors v ON v.id=b.vendor_id
      ORDER BY b.vendor_id, b.bill_date`);
    const onAccount = await q(`
      SELECT vp.vendor_id, v.name AS vendor_name, v.city, SUM(vp.amount) AS s
      FROM vendor_payments vp JOIN vendors v ON v.id=vp.vendor_id
      WHERE vp.purchase_bill_id IS NULL GROUP BY vp.vendor_id, v.name, v.city`);
    const by = {};
    const row = x => (by[x.vendor_id] ||= {
      vendor_id: x.vendor_id, vendor_name: x.vendor_name, city: x.city,
      billed: 0, paid: 0, on_account: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0, open_bills: 0 });
    const now = Date.now();
    for (const b of bills) {
      const v = row(b);
      v.billed += b.total; v.paid += b.paid;
      const due = b.total - b.paid;
      if (due > 0.01) {
        v.open_bills += 1;
        const days = Math.floor((now - new Date(b.bill_date).getTime()) / 864e5);
        if (days <= 30) v.b0_30 += due; else if (days <= 60) v.b31_60 += due;
        else if (days <= 90) v.b61_90 += due; else v.b90p += due;
      }
    }
    for (const a of onAccount) row(a).on_account += +a.s;
    res.json(Object.values(by)
      .map(v => ({ ...v, outstanding: r2(v.billed - v.paid - v.on_account) }))
      .sort((a, b) => b.outstanding - a.outstanding));
  } catch (e) { next(e); }
});

// ── Party ledger — one running statement for a customer or a vendor ─────────
// Debit raises what the party owes us; credit raises what we owe the party. So
// a customer's balance is debit − credit (receivable) and a vendor's is
// credit − debit (payable), and both read as a positive number when money is due.
r.get('/accounts/ledger', async (req, res, next) => {
  try {
    const id = +req.query.id;
    const isVendor = req.query.party === 'vendor';
    if (!id) throw fail(400, 'Choose a party');
    const party = isVendor
      ? await one('SELECT id, name, city, state, gstin FROM vendors WHERE id=$1', [id])
      : await one('SELECT id, name, city, state, gstin FROM customers WHERE id=$1', [id]);
    if (!party) throw fail(404, 'Party not found');
    const rows = isVendor
      ? await q(`
          SELECT b.bill_date AS date, 'Purchase bill' AS kind, b.bill_number AS number,
                 COALESCE(b.vendor_bill_no, '') AS reference, 0::float AS debit, b.total AS credit, b.id AS sort_id, 1 AS ord
          FROM purchase_bills b WHERE b.vendor_id=$1
          UNION ALL
          SELECT vp.paid_on, 'Payment', vp.payment_number,
                 CONCAT_WS(' · ', UPPER(vp.mode), vp.reference), vp.amount, 0, vp.id, 2
          FROM vendor_payments vp WHERE vp.vendor_id=$1
          ORDER BY date, ord, sort_id`, [id])
      : await q(`
          SELECT i.invoice_date AS date, 'Invoice' AS kind, i.invoice_number AS number,
                 '' AS reference, i.total AS debit, 0::float AS credit, i.id AS sort_id, 1 AS ord
          FROM invoices i WHERE i.customer_id=$1 AND i.status <> 'cancelled'
          UNION ALL
          SELECT ${RECEIPT_DAY}::text, 'Receipt', p.payment_number,
                 CONCAT_WS(' · ', UPPER(p.mode), p.reference), 0, p.amount, p.id, 2
          FROM payments p WHERE p.customer_id=$1
          ORDER BY date, ord, sort_id`, [id]);
    let balance = 0;
    const entries = rows.map(e => {
      balance = r2(balance + (isVendor ? e.credit - e.debit : e.debit - e.credit));
      return { date: e.date, kind: e.kind, number: e.number, reference: e.reference,
               debit: +e.debit, credit: +e.credit, balance };
    });
    res.json({ party: { ...party, type: isVendor ? 'vendor' : 'customer' }, entries, balance });
  } catch (e) { next(e); }
});

// ── Cash & bank book — money in and out, by plant day ───────────────────────
r.get('/accounts/cashbook', async (req, res, next) => {
  try {
    const from = req.query.from || null, to = req.query.to || null;
    const all = await q(`
      SELECT ${RECEIPT_DAY}::text AS date, 'in' AS direction, p.payment_number AS number, c.name AS party,
             p.mode, p.reference, i.invoice_number AS against, p.amount, p.id AS sort_id, 'payments' AS source
      FROM payments p JOIN customers c ON c.id=p.customer_id LEFT JOIN invoices i ON i.id=p.invoice_id
      UNION ALL
      SELECT vp.paid_on, 'out', vp.payment_number, v.name, vp.mode, vp.reference, b.bill_number, vp.amount, vp.id, 'vendor_payments'
      FROM vendor_payments vp JOIN vendors v ON v.id=vp.vendor_id LEFT JOIN purchase_bills b ON b.id=vp.purchase_bill_id
      ORDER BY date, sort_id`);
    let opening = 0, balance = 0;
    const entries = [];
    for (const e of all) {
      const signed = e.direction === 'in' ? +e.amount : -e.amount;
      if (from && e.date < from) { opening = r2(opening + signed); balance = opening; continue; }
      if (to && e.date > to) continue;
      balance = r2(balance + signed);
      entries.push({ ...e, id: `${e.source}-${e.sort_id}`, source_id: e.sort_id,
        money_in: e.direction === 'in' ? +e.amount : 0, money_out: e.direction === 'out' ? +e.amount : 0, balance });
    }
    res.json({ opening, entries, closing: balance });
  } catch (e) { next(e); }
});

export default r;
