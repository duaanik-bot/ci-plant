// Direct (trading) invoices — a tax invoice raised straight from stock.
//
// No order, no job card, no challan: pick a party, pick what is on the shelf —
// board from the warehouse or cartons from loose FG — and the invoice both
// bills it and takes it off the book, in one transaction. For goods the plant
// trades rather than makes.
//
// The header is an ordinary invoices row (kind='direct', CI-TRD- series), so
// payments, the outstanding ledger and the sales register need nothing new.
// The lines live in direct_invoice_lines, which no production query reads, so
// nothing on the manufacturing side can see — or be changed by — a direct sale.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { plantDateStr } from '../plant-calendar.js';
import { audit, nextNumber, lockDocNumber, fgIssue, adjustFgStock, moveBatchLevel, optionalText } from '../helpers.js';
import { billingEntity, isIntraState } from '../billing-entity.js';
import { requireRole } from '../auth.js';

const r = Router();
const canBill = requireRole('planner'); // admin implied — same right as cutting any invoice

export const DIRECT_PREFIX = 'CI-TRD-';
const REF = 'direct_invoice';
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = v => (Number.isFinite(+v) ? +v : NaN);
const trim3 = n => +(+n).toFixed(3);

// What can be sold right now: every board/material with available stock and
// every carton with loose FG. Rate and GST are suggestions the dialog pre-fills;
// the user types the selling rate.
r.get('/direct-invoices/items', async (_req, res, next) => {
  try {
    const boards = await q(`
      SELECT m.id AS material_id, m.name, m.code, m.category, m.unit,
             av.q AS available, m.hsn_code AS hsn, m.customer_id,
             m.gst_rate AS gst_pct, COALESCE(m.std_rate, m.last_rate) AS rate
      FROM materials m
      JOIN (SELECT material_id, SUM(qty) q FROM stock_batches
            WHERE status='available' AND qty > 0 GROUP BY material_id) av ON av.material_id = m.id
      ORDER BY m.category, m.name, m.id`);
    const cartons = await q(`
      SELECT p.id AS product_id, p.name, p.code, p.party_item_code, c.name AS customer_name,
             f.qty AS available, COALESCE(p.gst_pct, gr.rate, 12) AS gst_pct, p.rate
      FROM fg_stock f
      JOIN products p ON p.id = f.product_id
      JOIN customers c ON c.id = p.customer_id
      LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
      WHERE f.qty > 0
      ORDER BY p.name, p.id`);
    res.json({ boards, cartons });
  } catch (e) { next(e); }
});

// The Trading Items master (Masters → Trading Items): every trading item with
// what is on the shelf, in stock or not.
r.get('/direct-invoices/trading-items', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT m.*, c.name AS customer_name,
             COALESCE((SELECT SUM(b.qty) FROM stock_batches b
                       WHERE b.material_id = m.id AND b.status='available'), 0) AS in_stock
      FROM materials m LEFT JOIN customers c ON c.id = m.customer_id
      WHERE m.category = 'trading' ORDER BY m.name, m.id`));
  } catch (e) { next(e); }
});

// A preview for the dialog — the save mints its own inside its transaction.
r.get('/direct-invoices/next-number', async (_req, res, next) => {
  try { res.json({ invoice_number: await nextNumber(DIRECT_PREFIX, 'invoices', 'invoice_number', one) }); }
  catch (e) { next(e); }
});

// Take board off the shelf, oldest pile first. Refuses rather than writing the
// book past nil: a tax invoice for goods the book says are not there is a stock
// problem to fix first (Inventory → Stock Adjustment), not one to bill through.
async function takeBoard(m, qty, invId, invNumber, qc, oc) {
  // Same lock a plan freeze and a GRN cover take on this board, so a sale and
  // a hold cannot both read the same free sheets.
  await qc('SELECT pg_advisory_xact_lock(764001, $1)', [m.id]);
  const batches = await qc(
    `SELECT id, qty FROM stock_batches WHERE material_id=$1 AND status='available' AND qty > 0
     ORDER BY created_at, id FOR UPDATE`, [m.id]);
  const have = batches.reduce((s, b) => s + Number(b.qty || 0), 0);
  if (have + 1e-6 < qty)
    throw fail(409, `Only ${trim3(have)} ${m.unit} of ${m.name} in stock — cannot bill ${trim3(qty)}`);
  let left = qty;
  for (const b of batches) {
    if (left <= 1e-9) break;
    const take = Math.min(Number(b.qty), left);
    await moveBatchLevel(b.id, m.id, -take, qc, oc);
    // 'dispatch', not 'consumption': the board was sold, not printed on, and
    // every consumption report reads that type.
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'dispatch',$3,$4,$5,$6)`,
      [m.id, b.id, -take, REF, invId, `Sold on direct invoice ${invNumber}`]);
    left -= take;
  }
}

r.post('/direct-invoices', canBill, async (req, res, next) => {
  try {
    const { customer_id, invoice_date, notes } = req.body;
    const raw = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!customer_id || !raw.length) throw fail(400, 'A party and at least one item are required');

    const invId = await tx(async (qc, oc) => {
      // The number first, then stock rows — one order for every direct invoice.
      await lockDocNumber(DIRECT_PREFIX, oc);
      const customer = await oc('SELECT * FROM customers WHERE id=$1', [customer_id]);
      if (!customer) throw fail(404, 'Party not found');

      const lines = [];
      for (const [i, l] of raw.entries()) {
        const at = `Item ${i + 1}`;
        const qty = num(l.qty), rate = num(l.rate);
        if (!(qty > 0)) throw fail(400, `${at}: enter a quantity`);
        if (!(rate >= 0)) throw fail(400, `${at}: enter a rate`);
        if (l.item_type === 'board') {
          const m = await oc('SELECT id, name, unit, hsn_code, gst_rate, customer_id FROM materials WHERE id=$1', [l.material_id]);
          if (!m) throw fail(404, `${at}: material not found`);
          // An item kept for one customer is billed to that customer only —
          // two parties' accounts must never share a line by a slip of the picker.
          if (m.customer_id != null && m.customer_id !== customer.id) {
            const owner = await oc('SELECT name FROM customers WHERE id=$1', [m.customer_id]);
            throw fail(409, `${at}: ${m.name} belongs to ${owner?.name || 'another customer'} — it cannot be billed to ${customer.name}`);
          }
          const gst = l.gst_pct == null || l.gst_pct === '' ? num(m.gst_rate) : num(l.gst_pct);
          if (!(gst >= 0)) throw fail(400, `${at}: GST % cannot be negative`);
          lines.push({ item_type: 'board', master: m, material_id: m.id, product_id: null,
            description: optionalText(l.description) || m.name,
            hsn: optionalText(l.hsn) || m.hsn_code || null, unit: m.unit, qty, rate, gst_pct: gst });
        } else if (l.item_type === 'carton') {
          if (!Number.isInteger(qty)) throw fail(400, `${at}: cartons are billed in whole pieces`);
          const p = await oc(`
            SELECT p.id, p.name, p.code, COALESCE(p.gst_pct, gr.rate, 12) AS gst_pct
            FROM products p LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
            WHERE p.id=$1`, [l.product_id]);
          if (!p) throw fail(404, `${at}: product not found`);
          const gst = l.gst_pct == null || l.gst_pct === '' ? num(p.gst_pct) : num(l.gst_pct);
          if (!(gst >= 0)) throw fail(400, `${at}: GST % cannot be negative`);
          lines.push({ item_type: 'carton', master: p, material_id: null, product_id: p.id,
            description: optionalText(l.description) || `${p.name} (${p.code})`,
            hsn: optionalText(l.hsn) || null, unit: 'pcs', qty, rate, gst_pct: gst });
        } else {
          throw fail(400, `${at}: choose board or carton`);
        }
      }

      let subtotal = 0, tax = 0;
      for (const l of lines) {
        l.amount = +(l.qty * l.rate).toFixed(2);
        subtotal += l.amount;
        tax += l.amount * l.gst_pct / 100;
      }
      subtotal = +subtotal.toFixed(2);
      tax = +tax.toFixed(2);
      const entity = await billingEntity({ customer_id: customer.id }, oc);
      const intra = isIntraState(entity, customer);
      const cgst = intra ? +(tax / 2).toFixed(2) : 0;
      const sgst = intra ? +(tax / 2).toFixed(2) : 0;
      const igst = intra ? 0 : tax;
      const gross = subtotal + cgst + sgst + igst;
      const total = Math.round(gross);
      const round_off = +(total - gross).toFixed(2);

      const typed = optionalText(req.body.invoice_number);
      if (typed && await oc('SELECT id FROM invoices WHERE invoice_number=$1', [typed]))
        throw fail(409, `Invoice ${typed} already exists — pick another number`);
      const invoice_number = typed || await nextNumber(DIRECT_PREFIX, 'invoices', 'invoice_number', oc);

      const [inv] = await qc(`
        INSERT INTO invoices (invoice_number, customer_id, invoice_date, subtotal, cgst, sgst, igst, round_off, total, notes, billing_entity_id, kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'direct') RETURNING id`,
        [invoice_number, customer.id, invoice_date || plantDateStr(),
         subtotal, cgst, sgst, igst, round_off, total, optionalText(notes), entity.id ?? null]);

      for (const l of lines) {
        await qc(`INSERT INTO direct_invoice_lines
                    (invoice_id, item_type, material_id, product_id, description, hsn, unit, qty, rate, amount, gst_pct)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [inv.id, l.item_type, l.material_id, l.product_id, l.description,
           l.hsn || (l.item_type === 'carton' ? entity.hsn : null), l.unit, l.qty, l.rate, l.amount, l.gst_pct]);
      }

      // Stock leaves in ONE order — boards by id, then cartons by id — so two
      // direct invoices sharing items can never wait on each other in a ring.
      const stockOrder = [...lines].sort((a, b) =>
        (a.item_type === b.item_type ? 0 : a.item_type === 'board' ? -1 : 1)
        || (a.material_id ?? a.product_id) - (b.material_id ?? b.product_id));
      for (const l of stockOrder) {
        if (l.item_type === 'board') {
          await takeBoard(l.master, l.qty, inv.id, invoice_number, qc, oc);
        } else {
          try { await fgIssue(l.product_id, l.qty, REF, inv.id, qc, oc); }
          catch (e) {
            if (e.status !== 409) throw e;
            const have = await oc('SELECT qty FROM fg_stock WHERE product_id=$1', [l.product_id]);
            throw fail(409, `Only ${+have?.qty || 0} pcs of ${l.master.name} in FG stock — cannot bill ${l.qty}`);
          }
        }
      }

      await audit('invoice', inv.id, 'create',
        `${invoice_number} ₹${total} — direct invoice, ${lines.length} item${lines.length > 1 ? 's' : ''} from stock`,
        qc, req.user.name);
      return inv.id;
    });
    res.json(await one('SELECT * FROM invoices WHERE id=$1', [invId]));
  } catch (e) {
    if (e?.code === '23505' && /invoice_number/.test(e.constraint || '')) {
      e.status = 409;
      e.message = `Invoice ${req.body?.invoice_number} already exists — pick another number`;
    }
    next(e);
  }
});

// The lines of a direct invoice, shaped for the printable invoice page.
export function directInvoiceLines(invoiceId, qf = q) {
  return qf(`
    SELECT dil.*, COALESCE(p.name, m.name) AS item_name, COALESCE(p.code, m.code) AS item_code
    FROM direct_invoice_lines dil
    LEFT JOIN products p ON p.id = dil.product_id
    LEFT JOIN materials m ON m.id = dil.material_id
    WHERE dil.invoice_id=$1 ORDER BY dil.id`, [invoiceId]);
}

// Deleting a direct invoice puts its goods back: each board sheet returns to
// the pile it was taken from, each carton to loose FG. The ledger is appended
// to, never rewritten — the sale and its reversal both stay readable.
export async function reverseDirectInvoice(inv, qc, oc, user) {
  const taken = await qc(
    `SELECT material_id, batch_id, -qty AS qty FROM stock_movements
     WHERE ref_type=$1 AND ref_id=$2 AND type='dispatch' AND material_id IS NOT NULL
     ORDER BY material_id, batch_id`, [REF, inv.id]);
  for (const t of taken) {
    await moveBatchLevel(t.batch_id, t.material_id, +t.qty, qc, oc);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
      [t.material_id, t.batch_id, +t.qty, REF, inv.id, `Direct invoice ${inv.invoice_number} deleted — returned to stock`]);
  }
  const cartons = await qc(
    `SELECT product_id, SUM(qty)::int AS qty FROM direct_invoice_lines
     WHERE invoice_id=$1 AND item_type='carton' GROUP BY product_id ORDER BY product_id`, [inv.id]);
  for (const c of cartons) {
    await adjustFgStock({ product_id: c.product_id, qty: c.qty,
      note: `Direct invoice ${inv.invoice_number} deleted — returned to FG`, user }, qc, oc);
  }
  await qc('DELETE FROM direct_invoice_lines WHERE invoice_id=$1', [inv.id]);
}

export default r;
