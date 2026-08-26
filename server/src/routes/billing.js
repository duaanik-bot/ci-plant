// Billing — the Pureflix accounts spine, adapted for the plant.
// Invoices are cut from dispatched (challan) lines, GST splits by place of
// supply, payments knock invoices off, and the ledger shows who owes what.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { plantDateStr } from '../plant-calendar.js';
import { audit, nextNumber, shadeCardsFor, fgReceipt, fgMove, setLineStatus, forceLineStatus, boxLeftoverFromFg, optionalText } from '../helpers.js';
import { clashes, familyKey } from '../product-family.js';
import { billingEntity, isIntraState, HOUSE_FALLBACK } from '../billing-entity.js';
import { requireRole } from '../auth.js';

const r = Router();
const canBill = requireRole('planner'); // admin implied

// The plant bills under more than one name — Galpha Laboratories' cartons go
// out as Darbi Print Pack — so the letterhead, GSTIN and place-of-supply state
// come from billing_entities, resolved per customer and frozen on the document.
// This constant survives only as the last-resort letterhead for a database with
// no entity rows at all.
export const COMPANY = HOUSE_FALLBACK;

// The number a new invoice would take. Exposed so the Create Invoice dialog can
// PRE-FILL it and still let the user type over it — a number you can see before
// saving is a number you can correct.
r.get('/billing/next-invoice-number', async (_req, res, next) => {
  try { res.json({ invoice_number: await nextNumber('CI-INV-', 'invoices', 'invoice_number') }); }
  catch (e) { next(e); }
});

// An invoice number is typed by a human and must stay unique. Blank, or already
// on another invoice, is refused loudly rather than silently renumbered.
async function checkInvoiceNumber(number, oc, selfId = null) {
  // optionalText, never a bare String(): an absent field would otherwise become
  // the literal text 'undefined' and be stamped onto a tax invoice.
  const n = optionalText(number);
  if (!n) throw Object.assign(new Error('Invoice number cannot be blank'), { status: 400 });
  const clash = await oc(
    'SELECT id FROM invoices WHERE invoice_number=$1 AND ($2::int IS NULL OR id<>$2::int)', [n, selfId]);
  if (clash) throw Object.assign(new Error(`Invoice ${n} already exists — pick another number`), { status: 409 });
  return n;
}

// invoices.invoice_number is UNIQUE in the database, so checkInvoiceNumber is a
// friendly pre-flight and Postgres is the real guard. Two people saving the same
// number at the same moment still lose that race — translate the raw 23505 so
// they read the same sentence as everyone else instead of a constraint name.
function invoiceNumberClash(e, number) {
  if (e?.code === '23505' && /invoice_number/.test(e.constraint || '')) {
    e.status = 409;
    e.message = `Invoice ${number} already exists — pick another number`;
  }
  return e;
}

// The entity a document prints under, for a row that already carries its id.
const companyFor = (doc, oc = one) =>
  billingEntity({ entity_id: doc.billing_entity_id ?? null, customer_id: doc.customer_id }, oc);

// Dispatch lines that haven't been invoiced yet, grouped by customer.
r.get('/billing/uninvoiced', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT dl.id AS dispatch_line_id, dl.qty, d.challan_number, d.dispatched_at,
             o.po_number, c.id AS customer_id, c.name AS customer_name, c.state, c.gstin,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
             p.party_item_code,
             COALESCE(ol.gst_pct, p.gst_pct, gr.rate, 12) AS gst_pct,
             ol.rate, dl.qty * ol.rate AS amount
      FROM dispatch_lines dl
      JOIN dispatches d ON d.id = dl.dispatch_id
      JOIN orders o ON o.id = d.order_id
      JOIN customers c ON c.id = d.customer_id
      JOIN order_lines ol ON ol.id = dl.order_line_id
      JOIN products p ON p.id = dl.product_id
      LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
      LEFT JOIN invoice_lines il ON il.dispatch_line_id = dl.id
      WHERE il.id IS NULL
      ORDER BY c.name, d.id`);
    // Shade-card expiry engine: flag lines whose product's shade card has
    // crossed its 1-year lifespan, so billing warns before the sale closes.
    const shades = await shadeCardsFor(rows.map(r0 => r0.product_id));
    res.json(rows.map(r0 => {
      const sc = shades[r0.product_id];
      return { ...r0, shade_card_code: sc?.code || null,
               shade_age_days: sc?.age_days ?? null, shade_expired: !!sc?.expired };
    }));
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
             COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
             p.party_item_code,
             d.challan_number, o.po_number, dl.qty AS dispatched_qty,
             co.id AS coa_id, co.coa_number, co.status AS coa_status,
             pk.pack_boxes, pk.pack_qty_per_box, pk.packed_total
      FROM invoice_lines il
      JOIN products p ON p.id = il.product_id
      JOIN dispatch_lines dl ON dl.id = il.dispatch_line_id
      JOIN order_lines ol ON ol.id = dl.order_line_id
      JOIN dispatches d ON d.id = dl.dispatch_id
      JOIN orders o ON o.id = d.order_id
      LEFT JOIN coas co ON co.dispatch_line_id = dl.id
      LEFT JOIN LATERAL (
        SELECT js.pack_boxes, js.pack_qty_per_box,
               (SELECT COALESCE(SUM(total),0)::int FROM packing_lines WHERE job_stage_id=js.id) AS packed_total
        FROM job_cards jc JOIN job_stages js ON js.job_card_id=jc.id AND js.stage='pasting' AND js.status='completed'
        WHERE jc.order_line_id=dl.order_line_id LIMIT 1) pk ON true
      WHERE il.invoice_id=$1 ORDER BY il.id`, [inv.id]);
    inv.payments = await q('SELECT * FROM payments WHERE invoice_id=$1 ORDER BY id', [inv.id]);
    inv.company = await companyFor(inv);
    res.json(inv);
  } catch (e) { next(e); }
});

// Soft same-vehicle strength mix-up alarm: within the lines being invoiced,
// find the first same-vehicle, same-brand, different-strength pair (e.g.
// NICOSTAR 5 and NICOSTAR 10 that rode out on the same truck). Lines with no
// vehicle recorded are skipped — "same vehicle" can't be asserted without one.
// Returns the collision payload for a structured 409, or null when clean.
function firstVehicleClash(lines) {
  const byVehicle = {};
  for (const l of lines) {
    if (!l.vehicle) continue;
    (byVehicle[l.vehicle] ||= []).push(l);
  }
  for (const [vehicle, vls] of Object.entries(byVehicle)) {
    for (let i = 0; i < vls.length; i++) {
      for (let j = i + 1; j < vls.length; j++) {
        const a = { product_id: vls[i].product_id, customer_id: vls[i].customer_id, name: vls[i].product_name };
        const b = { product_id: vls[j].product_id, customer_id: vls[j].customer_id, name: vls[j].product_name };
        if (clashes(a, b)) {
          return {
            vehicle,
            challans: [...new Set([vls[i].challan_number, vls[j].challan_number].filter(Boolean))],
            pair: [a, b].map((x) => ({ product_name: x.name, strength: familyKey(x.name).strength })),
          };
        }
      }
    }
  }
  return null;
}

// Cut an invoice from uninvoiced dispatch lines of one customer.
r.post('/invoices', canBill, async (req, res, next) => {
  try {
    const { customer_id, dispatch_line_ids, invoice_date, notes, confirm_collision } = req.body;
    if (!customer_id || !dispatch_line_ids?.length) {
      return res.status(400).json({ error: 'Customer and at least one dispatch line are required' });
    }
    const invId = await tx(async (qc, oc) => {
      const customer = await oc('SELECT * FROM customers WHERE id=$1', [customer_id]);
      if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

      let subtotal = 0, tax = 0;
      const lines = [];
      for (const dlId of dispatch_line_ids) {
        const row = await oc(`
          SELECT dl.id, dl.qty, dl.product_id, d.customer_id, ol.rate,
                 p.name AS product_name, p.party_item_code,
                 COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
                 d.vehicle, d.challan_number,
                 COALESCE(ol.gst_pct, p.gst_pct, gr.rate, 12) AS gst_pct,
                 (SELECT COUNT(*)::int FROM invoice_lines il WHERE il.dispatch_line_id=dl.id) AS invoiced
          FROM dispatch_lines dl
          JOIN dispatches d ON d.id = dl.dispatch_id
          JOIN order_lines ol ON ol.id = dl.order_line_id
          JOIN products p ON p.id = dl.product_id
          LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
          WHERE dl.id=$1 FOR UPDATE OF dl`, [dlId]);
        if (!row) throw Object.assign(new Error(`Dispatch line ${dlId} not found`), { status: 404 });
        if (row.customer_id !== customer.id)
          throw Object.assign(new Error('All lines must belong to the same customer'), { status: 409 });
        if (row.invoiced > 0)
          throw Object.assign(new Error('A selected line is already invoiced'), { status: 409 });
        const amount = +(row.qty * row.rate).toFixed(2);
        subtotal += amount;
        tax += amount * row.gst_pct / 100; // per-line GST — cartons ship at 5% or 12%
        lines.push({ ...row, amount });
      }
      subtotal = +subtotal.toFixed(2);
      tax = +tax.toFixed(2);

      // Soft alarm — "Yes" re-submits with confirm_collision; the ack is audited below.
      const collision = firstVehicleClash(lines);
      if (collision && !confirm_collision) {
        const e = new Error('Same-vehicle strength check');
        e.status = 409;
        e.body = { code: 'PRODUCT_STRENGTH_COLLISION', collision };
        throw e;
      }

      // Place of supply reads the SELLING entity's state, not a hardcoded
      // Punjab: a Darbi Print Pack invoice must split on where Darbi is
      // registered, which is the point of separating the entities.
      const entity = await billingEntity({ customer_id: customer.id }, oc);
      const intra = isIntraState(entity, customer);
      const cgst = intra ? +(tax / 2).toFixed(2) : 0;
      const sgst = intra ? +(tax / 2).toFixed(2) : 0;
      const igst = intra ? 0 : tax;
      const gross = subtotal + cgst + sgst + igst;
      const total = Math.round(gross);
      const round_off = +(total - gross).toFixed(2);

      // The next number in sequence unless the user typed one over it.
      const typedNumber = optionalText(req.body.invoice_number);
      const invoice_number = typedNumber
        ? await checkInvoiceNumber(typedNumber, oc)
        : await nextNumber('CI-INV-', 'invoices', 'invoice_number', oc);
      const [inv] = await qc(`
        INSERT INTO invoices (invoice_number, customer_id, invoice_date, subtotal, cgst, sgst, igst, round_off, total, notes, billing_entity_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [invoice_number, customer.id, invoice_date || plantDateStr(),
         subtotal, cgst, sgst, igst, round_off, total, notes || null, entity.id ?? null]);
      for (const l of lines) {
        await qc('INSERT INTO invoice_lines (invoice_id, dispatch_line_id, product_id, qty, rate, amount, gst_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [inv.id, l.id, l.product_id, l.qty, l.rate, l.amount, l.gst_pct]);
      }
      // COAs already drafted against these challan lines now belong to this invoice.
      await qc('UPDATE coas SET invoice_id=$1 WHERE dispatch_line_id = ANY($2) AND invoice_id IS NULL',
        [inv.id, dispatch_line_ids]);
      await audit('invoice', inv.id, 'create', `${invoice_number} ₹${total}`, qc, req.user.name);
      if (collision && confirm_collision) {
        const names = collision.pair.map((x) => `${x.product_name} (${x.strength})`).join(' + ');
        await audit('invoice', inv.id, 'strength_collision_ack',
          `Billed despite same-vehicle (${collision.vehicle}) strength clash: ${names}`, qc, req.user.name);
      }
      return inv.id;
    });
    const invoice = await one('SELECT * FROM invoices WHERE id=$1', [invId]);
    // Fulfilled-but-not-yet-completed items behind this invoice — the frontend
    // uses these to prompt "mark complete?" right after billing.
    invoice.completable = await q(`
      SELECT ol.id AS order_line_id, ol.order_id, o.po_number, o.status AS order_status,
             p.name AS product_name, p.code AS product_code,
             COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
             p.party_item_code, ol.qty, ol.dispatched_qty
      FROM invoice_lines il
      JOIN dispatch_lines dl ON dl.id = il.dispatch_line_id
      JOIN order_lines ol ON ol.id = dl.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN products p ON p.id = ol.product_id
      WHERE il.invoice_id = $1 AND ol.completed_at IS NULL
        AND ol.status <> 'cancelled' AND ol.dispatched_qty >= ol.qty
      -- GROUP BY the product's KEY, not its name. Two invoice lines can share an
      -- order line, so the de-duplication is real; but grouping on p.name leaves
      -- p.code, p.party_item_code and the artwork COALESCE functionally
      -- undetermined, and Postgres rejects the whole statement.
      --
      -- This runs AFTER tx() has committed, so the failure mode was silent and
      -- expensive: the invoice was written and the request still answered 500.
      -- The bill existed while the screen said it had failed, the "mark
      -- complete?" prompt never fired, and clicking again hit "A selected line
      -- is already invoiced".
      GROUP BY ol.id, o.id, p.id`, [invId]);
    res.json(invoice);
  } catch (e) { next(invoiceNumberClash(e, req.body?.invoice_number)); }
});

// Edit an invoice. Header fields (date, notes) are always editable while the
// invoice is open; line amounts are locked the moment a payment lands — a
// billed-and-part-paid document must not drift under the customer's ledger.
r.put('/invoices/:id', canBill, async (req, res, next) => {
  try {
    const { invoice_date, notes, lines, invoice_number } = req.body;
    const invId = await tx(async (qc, oc) => {
      const inv = await oc('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
      if (inv.status === 'cancelled')
        throw Object.assign(new Error('Cancelled invoices cannot be edited'), { status: 409 });

      if (lines?.length) {
        const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id=$1', [inv.id]);
        if (paid.s > 0)
          throw Object.assign(new Error('Payments are recorded against this invoice — amounts are locked (date and notes stay editable)'), { status: 409 });
        for (const l of lines) {
          const il = await oc(`
            SELECT il.*, dl.qty AS dispatched_qty FROM invoice_lines il
            JOIN dispatch_lines dl ON dl.id=il.dispatch_line_id
            WHERE il.id=$1 AND il.invoice_id=$2 FOR UPDATE OF il`, [l.id, inv.id]);
          if (!il) throw Object.assign(new Error(`Invoice line ${l.id} not found`), { status: 404 });
          const qty = l.qty != null ? +l.qty : il.qty;
          const rate = l.rate != null ? +l.rate : il.rate;
          const gst = l.gst_pct != null ? +l.gst_pct : (il.gst_pct ?? 12);
          if (!(qty > 0) || rate < 0 || gst < 0)
            throw Object.assign(new Error('Quantity must be positive; rate and GST cannot be negative'), { status: 400 });
          if (qty > il.dispatched_qty)
            throw Object.assign(new Error(`Cannot bill ${qty} — only ${il.dispatched_qty} dispatched on the challan`), { status: 409 });
          const amount = +(qty * rate).toFixed(2);
          if (qty !== il.qty || rate !== il.rate || gst !== (il.gst_pct ?? 12))
            await audit('invoice', inv.id, 'edit_line',
              `line ${il.id}: qty ${il.qty}→${qty}, rate ${il.rate}→${rate}, gst ${il.gst_pct ?? 12}→${gst}`,
              qc, req.user.name);
          await qc('UPDATE invoice_lines SET qty=$1, rate=$2, amount=$3, gst_pct=$4 WHERE id=$5',
            [qty, rate, amount, gst, il.id]);
        }
        // Recompute the GST split from what the lines now say.
        const all = await qc('SELECT amount, COALESCE(gst_pct,12) AS gst_pct FROM invoice_lines WHERE invoice_id=$1', [inv.id]);
        const customer = await oc('SELECT * FROM customers WHERE id=$1', [inv.customer_id]);
        let subtotal = 0, tax = 0;
        for (const l of all) { subtotal += l.amount; tax += l.amount * l.gst_pct / 100; }
        subtotal = +subtotal.toFixed(2); tax = +tax.toFixed(2);
        const intra = isIntraState(await companyFor(inv, oc), customer);
        const cgst = intra ? +(tax / 2).toFixed(2) : 0;
        const sgst = intra ? +(tax / 2).toFixed(2) : 0;
        const igst = intra ? 0 : tax;
        const gross = subtotal + cgst + sgst + igst;
        const total = Math.round(gross);
        const round_off = +(total - gross).toFixed(2);
        await qc('UPDATE invoices SET subtotal=$1, cgst=$2, sgst=$3, igst=$4, round_off=$5, total=$6 WHERE id=$7',
          [subtotal, cgst, sgst, igst, round_off, total, inv.id]);
      }

      // Renumbering is audited under BOTH numbers — searching the log for the
      // old one or the new one has to find the moment it moved.
      let number = inv.invoice_number;
      const typedNumber = optionalText(invoice_number);
      if (typedNumber && typedNumber !== String(inv.invoice_number)) {
        number = await checkInvoiceNumber(typedNumber, oc, inv.id);
        await audit('invoice', inv.id, 'renumber', `${inv.invoice_number} → ${number}`, qc, req.user.name);
      }
      await qc('UPDATE invoices SET invoice_number=$1, invoice_date=COALESCE($2,invoice_date), notes=COALESCE($3,notes) WHERE id=$4',
        [number, invoice_date || null, notes ?? null, inv.id]);
      await audit('invoice', inv.id, 'edit', number, qc, req.user.name);
      return inv.id;
    });
    const inv = await one(`
      SELECT i.*, c.name AS customer_name, c.city, c.state, c.gstin,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id=i.id),0) AS paid
      FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [invId]);
    res.json(inv);
  } catch (e) { next(invoiceNumberClash(e, req.body?.invoice_number)); }
});

// Remove a line from an invoice, with a destination for the goods it billed:
//   'remove'      — just un-bill it (the dispatch/challan stays as-is)
//   'to_fg'       — un-bill AND reverse the dispatch: goods return to FG stock
//   'to_leftover' — un-bill, return to FG, and box the qty as a leftover box
// Blocked once any payment is recorded (amounts are locked) or if cancelled.
r.post('/invoices/:id/lines/:lineId/remove', canBill, async (req, res, next) => {
  try {
    const action = ['remove', 'to_fg', 'to_leftover'].includes(req.body.action) ? req.body.action : 'remove';
    await tx(async (qc, oc) => {
      const inv = await oc('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
      if (inv.status === 'cancelled') throw Object.assign(new Error('Cancelled invoices cannot be edited'), { status: 409 });
      const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id=$1', [inv.id]);
      if (+paid.s > 0) throw Object.assign(new Error('Payments are recorded — remove the payment before editing lines'), { status: 409 });

      const il = await oc(`
        SELECT il.*, dl.id AS dl_id, dl.dispatch_id, dl.qty AS dl_qty, dl.product_id,
               d.order_id, ol.id AS order_line_id, ol.qty AS ordered, ol.dispatched_qty, ol.status AS line_status
        FROM invoice_lines il
        JOIN dispatch_lines dl ON dl.id=il.dispatch_line_id
        JOIN dispatches d ON d.id=dl.dispatch_id
        JOIN order_lines ol ON ol.id=dl.order_line_id
        WHERE il.id=$1 AND il.invoice_id=$2 FOR UPDATE OF il`, [req.params.lineId, inv.id]);
      if (!il) throw Object.assign(new Error('Invoice line not found'), { status: 404 });

      // Always drop the invoice line first (frees the dispatch line).
      await qc('DELETE FROM invoice_lines WHERE id=$1', [il.id]);

      if (action !== 'remove') {
        // Reverse the dispatch: the billed qty goes back to FG stock and the
        // challan line is removed (a draft COA on it goes too; an issued COA blocks).
        const coa = await oc('SELECT * FROM coas WHERE dispatch_line_id=$1', [il.dl_id]);
        if (coa?.status === 'issued')
          throw Object.assign(new Error(`${coa.coa_number} is issued on this line — reopen the COA first`), { status: 409 });
        if (coa) await qc('DELETE FROM coas WHERE id=$1', [coa.id]);
        // to_fg returns the goods to loose FG stock; to_leftover boxes them
        // directly (they never re-enter loose stock).
        if (action === 'to_fg')
          await fgReceipt(il.product_id, il.dl_qty, 'invoice_return', inv.id, qc);
        await qc('DELETE FROM dispatch_lines WHERE id=$1', [il.dl_id]);
        const newDispatched = Math.max(0, il.dispatched_qty - il.dl_qty);
        await qc('UPDATE order_lines SET dispatched_qty=$1 WHERE id=$2', [newDispatched, il.order_line_id]);
        if (il.line_status === 'dispatched' && newDispatched < il.ordered)
          await forceLineStatus(il.order_line_id, 'produced', 'invoice line pushed back off dispatch', qc, oc, req.user.name);
        // A challan left with no lines is cleaned up.
        const left = await oc('SELECT COUNT(*)::int AS n FROM dispatch_lines WHERE dispatch_id=$1', [il.dispatch_id]);
        if (left.n === 0) await qc('DELETE FROM dispatches WHERE id=$1', [il.dispatch_id]);
        // Reopen the order if a line came back.
        await qc(`UPDATE orders SET status='pending' WHERE id=$1 AND status='completed'`, [il.order_id]);

        if (action === 'to_leftover')
          await boxLeftoverFromFg(
            { product_id: il.product_id, qty: il.dl_qty, created_by: req.user.name, reduceFg: false,
              remarks: `Boxed as leftover from invoice ${inv.invoice_number}` }, qc, oc);
      }

      // Recompute the invoice totals from the remaining lines.
      const all = await qc('SELECT amount, COALESCE(gst_pct,12) AS gst_pct FROM invoice_lines WHERE invoice_id=$1', [inv.id]);
      const customer = await oc('SELECT * FROM customers WHERE id=$1', [inv.customer_id]);
      let subtotal = 0, tax = 0;
      for (const l of all) { subtotal += +l.amount; tax += l.amount * l.gst_pct / 100; }
      subtotal = +subtotal.toFixed(2); tax = +tax.toFixed(2);
      const intra = isIntraState(await companyFor(inv, oc), customer);
      const cgst = intra ? +(tax / 2).toFixed(2) : 0, sgst = intra ? +(tax / 2).toFixed(2) : 0, igst = intra ? 0 : tax;
      const gross = subtotal + cgst + sgst + igst, total = Math.round(gross);
      await qc('UPDATE invoices SET subtotal=$1, cgst=$2, sgst=$3, igst=$4, round_off=$5, total=$6 WHERE id=$7',
        [subtotal, cgst, sgst, igst, +(total - gross).toFixed(2), total, inv.id]);
      await audit('invoice', inv.id, 'remove_line',
        `line ${il.id} (${il.dl_qty} pcs) — ${action === 'remove' ? 'un-billed' : action === 'to_fg' ? 'returned to FG' : 'boxed as leftover'}`, qc, req.user.name);
    });
    res.json(await one(`SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Delete an invoice — voids the bill and returns its dispatch lines to
// un-invoiced (they reappear in Billing → uninvoiced, ready to re-bill). The
// dispatch/challan and the goods are untouched; only the billing document is
// removed. Blocked once a payment is recorded (reverse it first) or if an issued
// COA hangs off the invoice (reopen it first). Draft COAs detach back to their
// dispatch line so a re-bill re-links them, mirroring how create() links them.
r.delete('/invoices/:id', canBill, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const inv = await oc('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
      const paid = await oc('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id=$1', [inv.id]);
      if (+paid.s > 0)
        throw Object.assign(new Error('Payments are recorded against this invoice — reverse the payment before deleting'), { status: 409 });
      const issued = await oc(`SELECT coa_number FROM coas WHERE invoice_id=$1 AND status='issued' LIMIT 1`, [inv.id]);
      if (issued)
        throw Object.assign(new Error(`${issued.coa_number} is issued on this invoice — reopen the COA before deleting`), { status: 409 });
      // Detach draft COAs (FK) → they revert to unlinked drafts on their dispatch line.
      await qc('UPDATE coas SET invoice_id=NULL WHERE invoice_id=$1', [inv.id]);
      // Dropping the lines frees the dispatch lines back to un-invoiced.
      await qc('DELETE FROM invoice_lines WHERE invoice_id=$1', [inv.id]);
      await qc('DELETE FROM invoices WHERE id=$1', [inv.id]);
      await audit('invoice', inv.id, 'delete',
        `${inv.invoice_number} ₹${inv.total} deleted — line(s) returned to un-invoiced`, qc, req.user.name);
    });
    res.json({ ok: true });
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

// ── Sales & purchase registers ──────────────────────────────────────────────
// The Accounts page view: what was sold and what was bought in a period.
// Sales = tax invoices, purchases = POs raised. Timeline is a fixed 12-month
// strip regardless of the filter so the page can offer month jumping.
r.get('/accounts/registers', async (req, res, next) => {
  try {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const sales = await q(`
      SELECT i.id, i.invoice_number, i.invoice_date, i.subtotal,
             (i.cgst + i.sgst + i.igst) AS tax, i.total, i.status,
             c.id AS customer_id, c.name AS customer_name, c.city, c.state, c.segment,
             COALESCE((SELECT SUM(il.qty) FROM invoice_lines il WHERE il.invoice_id=i.id),0)::int AS qty
      FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status != 'cancelled'
        AND ($1::date IS NULL OR i.invoice_date::date >= $1::date)
        AND ($2::date IS NULL OR i.invoice_date::date <= $2::date)
      ORDER BY i.invoice_date DESC, i.id DESC`, [from, to]);
    const saleProducts = await q(`
      SELECT p.id, p.name, p.code, p.size,
             SUM(il.qty)::int AS qty, SUM(il.amount) AS value,
             COUNT(DISTINCT i.id)::int AS invoices,
             COUNT(DISTINCT i.customer_id)::int AS customers
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id AND i.status != 'cancelled'
      JOIN products p ON p.id = il.product_id
      WHERE ($1::date IS NULL OR i.invoice_date::date >= $1::date)
        AND ($2::date IS NULL OR i.invoice_date::date <= $2::date)
      GROUP BY p.id ORDER BY value DESC`, [from, to]);
    const purchases = await q(`
      SELECT po.id, po.po_number, po.created_at, po.status,
             v.id AS vendor_id, v.name AS vendor_name, v.city,
             COUNT(pl.id)::int AS line_count,
             COALESCE(SUM(pl.qty),0) AS ordered_qty,
             COALESCE(SUM(pl.received_qty),0) AS received_qty,
             COALESCE(SUM(pl.qty * pl.rate),0) AS value,
             STRING_AGG(DISTINCT m.category, ', ') AS categories
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.vendor_id
      LEFT JOIN po_lines pl ON pl.purchase_order_id = po.id
      LEFT JOIN materials m ON m.id = pl.material_id
      WHERE ($1::date IS NULL OR po.created_at::date >= $1::date)
        AND ($2::date IS NULL OR po.created_at::date <= $2::date)
      GROUP BY po.id, v.id ORDER BY po.id DESC`, [from, to]);
    const salesMonthly = await q(`
      SELECT to_char(i.invoice_date::date,'YYYY-MM') AS month,
             SUM(i.total) AS value, COUNT(*)::int AS docs,
             COALESCE(SUM((SELECT SUM(il.qty) FROM invoice_lines il WHERE il.invoice_id=i.id)),0)::int AS qty
      FROM invoices i
      WHERE i.status != 'cancelled'
        AND i.invoice_date::date > (current_date - interval '12 months')
      GROUP BY 1 ORDER BY 1`);
    const purchaseMonthly = await q(`
      SELECT to_char(po.created_at,'YYYY-MM') AS month,
             COALESCE(SUM(pl.qty * pl.rate),0) AS value,
             COALESCE(SUM(pl.qty),0) AS qty,
             COUNT(DISTINCT po.id)::int AS docs
      FROM purchase_orders po LEFT JOIN po_lines pl ON pl.purchase_order_id = po.id
      WHERE po.created_at > (current_date - interval '12 months')
      GROUP BY 1 ORDER BY 1`);
    res.json({
      sales, purchases, sale_products: saleProducts,
      timeline: { sales: salesMonthly, purchases: purchaseMonthly },
    });
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
