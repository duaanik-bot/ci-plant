// Certificates of Analysis — one per dispatch line. The draft assembles
// itself from the product master (spec_override honoured), the job card and
// the completed release stage; it is edited, issued, and the snapshot never
// changes again. Issued COAs reopen only under the admin role.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, effectiveProduct } from '../helpers.js';
import { requireRole } from '../auth.js';
import { COMPANY } from './billing.js';

const r = Router();
const canCoa = requireRole('qc', 'dispatch', 'planner');

// The quality release statement carried on every certificate. Stored onto the
// draft (rather than rendered as a template fallback) so the wording is frozen
// into the snapshot the customer received, and stays editable before issue.
export const QUALITY_DECLARATION =
  'Certified that the material covered by this certificate has been inspected by Quality Control '
  + 'against the approved specification, artwork and shade card, and that all parameters listed above '
  + 'conform to the stated standards with no deviation observed. The batch is approved by Quality and '
  + 'released for dispatch.';

const COATING_LABEL = {
  aqueous: 'Aqueous coating', uv: 'UV coating',
  matt_lam: 'Matt lamination', gloss_lam: 'Gloss lamination',
};
const SPECIAL_LABEL = {
  foil: 'Hot foil stamping', emboss: 'Embossing',
  foil_emboss: 'Hot foil stamping + embossing', window: 'Window patching',
};

// The industry-standard parameter grid for a printed-carton COA. Standard
// values come from the effective product spec; observed defaults to
// "Complies" and QC edits before issuing.
function draftParams(product, board) {
  const rows = [];
  const add = (parameter, standard) =>
    rows.push({ parameter, standard, observed: 'Complies', result: 'Pass' });

  if (product.size) add('Product / carton size', product.size);
  add('Board substrate', [board?.name, product.gsm ? `${product.gsm} GSM ± 5%` : null].filter(Boolean).join(' · ') || 'As per approved specification');
  if (product.child_l && product.child_w) add('Print sheet size', `${product.child_l} × ${product.child_w} in`);
  add('Printing colours', `${product.colors || '—'} colours as per approved artwork`);
  add('Shade matching', 'As per approved shade card');
  add('Text matter & artwork', 'As per approved artwork — no deviation');
  add('Print quality', 'No misregister, scumming, set-off or hickies');
  if (product.coating && product.coating !== 'none')
    add('Coating / finish', COATING_LABEL[product.coating] || product.coating);
  if (product.special && product.special !== 'none')
    add('Special finish', SPECIAL_LABEL[product.special] || product.special);
  add('Dimensions & creasing', 'Within ±1 mm of approved dimensions; crease lines sharp, no cracking');
  add('Pasting / bonding', 'Firm side-seam bonding, no glue smear or warping');
  add('Cleanliness', 'Free from dust, foreign matter and odour');
  return rows;
}

// Display-ready COA with all reference fields joined in.
async function fullCoa(id, oc = one) {
  const c = await oc(`
    SELECT co.*, p.name AS product_name, p.code AS product_code,
           p.party_artwork_code, p.party_item_code, p.size AS product_size,
           cu.name AS customer_name, cu.city, cu.state, cu.gstin,
           d.challan_number, d.dispatched_at, o.po_date,
           jc.jc_number, i.invoice_number, i.invoice_date
    FROM coas co
    JOIN products p ON p.id=co.product_id
    JOIN customers cu ON cu.id=co.customer_id
    JOIN dispatches d ON d.id=co.dispatch_id
    JOIN orders o ON o.id=d.order_id
    LEFT JOIN job_cards jc ON jc.id=co.job_card_id
    LEFT JOIN invoices i ON i.id=co.invoice_id
    WHERE co.id=$1`, [id]);
  if (c) c.company = COMPANY;
  return c;
}

r.get('/coas', async (req, res, next) => {
  try {
    const { dispatch_id, invoice_id } = req.query;
    res.json(await q(`
      SELECT co.*, p.name AS product_name, p.code AS product_code,
             p.party_artwork_code, p.party_item_code,
             cu.name AS customer_name, d.challan_number, i.invoice_number
      FROM coas co
      JOIN products p ON p.id=co.product_id
      JOIN customers cu ON cu.id=co.customer_id
      JOIN dispatches d ON d.id=co.dispatch_id
      LEFT JOIN invoices i ON i.id=co.invoice_id
      WHERE ($1::int IS NULL OR co.dispatch_id=$1::int)
        AND ($2::int IS NULL OR co.invoice_id=$2::int)
      ORDER BY co.id DESC`, [dispatch_id || null, invoice_id || null]));
  } catch (e) { next(e); }
});

r.get('/coas/:id', async (req, res, next) => {
  try {
    const c = await fullCoa(req.params.id);
    if (!c) return res.status(404).json({ error: 'COA not found' });
    res.json(c);
  } catch (e) { next(e); }
});

// Create (or return the existing) COA draft for a dispatch line.
// Idempotent on purpose — the "COA" button never needs to know whether one
// exists already. Optional invoice_id links the certificate to an invoice.
r.post('/coas', canCoa, async (req, res, next) => {
  try {
    const { dispatch_line_id, invoice_id } = req.body;
    if (!dispatch_line_id) return res.status(400).json({ error: 'dispatch_line_id is required' });

    const coaId = await tx(async (qc, oc) => {
      const existing = await oc('SELECT id FROM coas WHERE dispatch_line_id=$1', [dispatch_line_id]);
      if (existing) {
        if (invoice_id) await qc('UPDATE coas SET invoice_id=COALESCE(invoice_id,$1) WHERE id=$2', [invoice_id, existing.id]);
        return existing.id;
      }

      const dl = await oc(`
        SELECT dl.id, dl.qty, dl.dispatch_id, dl.order_line_id, dl.product_id,
               d.customer_id, o.po_number,
               ol.spec_override,
               jc.id AS job_card_id, jc.jc_number, jc.closed_at
        FROM dispatch_lines dl
        JOIN dispatches d ON d.id=dl.dispatch_id
        JOIN orders o ON o.id=d.order_id
        JOIN order_lines ol ON ol.id=dl.order_line_id
        LEFT JOIN job_cards jc ON jc.order_line_id=ol.id
        WHERE dl.id=$1`, [dispatch_line_id]);
      if (!dl) throw Object.assign(new Error('Dispatch line not found'), { status: 404 });

      const master = await oc('SELECT * FROM products WHERE id=$1', [dl.product_id]);
      const product = effectiveProduct(master, dl);
      const board = await oc('SELECT * FROM materials WHERE id=$1', [product.board_material_id]);
      // Inspection figures come from the completed PASTING stage — Sort & Paste
      // is the release point now that the separate QC hop is gone. Its counted
      // good and its NCR-reasoned waste are the accepted / rejected figures.
      // Job cards closed under the old route still have a completed qc stage, so
      // that is preferred when present and the certificate stays true either way.
      const relStage = dl.job_card_id ? await oc(`
        SELECT qty_in, qty_out, qty_scrap, qty_accepted, qty_rejected, stage
        FROM job_stages
        WHERE job_card_id=$1 AND status='completed' AND stage IN ('qc','pasting')
        ORDER BY (stage='qc') DESC, seq DESC LIMIT 1`, [dl.job_card_id]) : null;

      const sampling = {
        lot_size: relStage?.qty_in ?? dl.qty,
        sample_size: null,
        aql: 'As per IS 2500 (General Inspection Level II)',
        accepted: relStage ? (relStage.qty_accepted ?? relStage.qty_out) : null,
        rejected: relStage ? (relStage.qty_rejected ?? relStage.qty_scrap) : null,
      };

      const coa_number = await nextNumber('CI-COA-', 'coas', 'coa_number', oc);
      const [c] = await qc(`
        INSERT INTO coas (coa_number, dispatch_line_id, dispatch_id, order_line_id, job_card_id,
                          product_id, customer_id, invoice_id, qty, batch_no, mfg_date, po_number,
                          params, sampling, remarks, inspected_by, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [coa_number, dl.id, dl.dispatch_id, dl.order_line_id, dl.job_card_id,
         dl.product_id, dl.customer_id, invoice_id || null, dl.qty, dl.jc_number || null,
         dl.closed_at ? String(dl.closed_at.toISOString?.() || dl.closed_at).slice(0, 10) : null,
         dl.po_number || null,
         JSON.stringify(draftParams(product, board)), JSON.stringify(sampling),
         QUALITY_DECLARATION, null, req.user.name]);
      await audit('coa', c.id, 'create', coa_number, qc, req.user.name);
      return c.id;
    });
    res.json(await fullCoa(coaId));
  } catch (e) { next(e); }
});

// Edit a COA. Drafts are freely editable; an issued certificate is frozen —
// only an admin may change it (audited), so what the customer received stays true.
r.put('/coas/:id', canCoa, async (req, res, next) => {
  try {
    const coaId = await tx(async (qc, oc) => {
      const c = await oc('SELECT * FROM coas WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!c) throw Object.assign(new Error('COA not found'), { status: 404 });
      if (c.status === 'issued' && req.user.role !== 'admin')
        throw Object.assign(new Error(`${c.coa_number} is issued and frozen — ask an admin to amend it`), { status: 409 });

      const b = req.body;
      await qc(`
        UPDATE coas SET
          qty=COALESCE($1,qty), batch_no=COALESCE($2,batch_no), mfg_date=COALESCE($3,mfg_date),
          po_number=COALESCE($4,po_number), params=COALESCE($5,params), sampling=COALESCE($6,sampling),
          remarks=COALESCE($7,remarks), inspected_by=COALESCE($8,inspected_by),
          approved_by=COALESCE($9,approved_by), updated_at=now()
        WHERE id=$10`,
        [b.qty ?? null, b.batch_no ?? null, b.mfg_date ?? null, b.po_number ?? null,
         b.params ? JSON.stringify(b.params) : null, b.sampling ? JSON.stringify(b.sampling) : null,
         b.remarks ?? null, b.inspected_by ?? null, b.approved_by ?? null, c.id]);
      if (c.status === 'issued')
        await audit('coa', c.id, 'amend_issued', `${c.coa_number} amended after issue`, qc, req.user.name);
      return c.id;
    });
    res.json(await fullCoa(coaId));
  } catch (e) { next(e); }
});

// Issue — the certificate becomes final. Approved-by defaults to the issuer.
r.post('/coas/:id/issue', canCoa, async (req, res, next) => {
  try {
    const coaId = await tx(async (qc, oc) => {
      const c = await oc('SELECT * FROM coas WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!c) throw Object.assign(new Error('COA not found'), { status: 404 });
      if (c.status === 'issued')
        throw Object.assign(new Error(`${c.coa_number} is already issued`), { status: 409 });
      await qc(`UPDATE coas SET status='issued', issued_at=now(),
                approved_by=COALESCE($1, approved_by, $2), updated_at=now() WHERE id=$3`,
        [req.body?.approved_by || null, req.user.name, c.id]);
      await audit('coa', c.id, 'issue', c.coa_number, qc, req.user.name);
      return c.id;
    });
    res.json(await fullCoa(coaId));
  } catch (e) { next(e); }
});

// Reopen an issued COA back to draft — admin only, audited.
r.post('/coas/:id/reopen', requireRole(), async (req, res, next) => {
  try {
    const coaId = await tx(async (qc, oc) => {
      const c = await oc('SELECT * FROM coas WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!c) throw Object.assign(new Error('COA not found'), { status: 404 });
      await qc(`UPDATE coas SET status='draft', issued_at=NULL, updated_at=now() WHERE id=$1`, [c.id]);
      await audit('coa', c.id, 'reopen', c.coa_number, qc, req.user.name);
      return c.id;
    });
    res.json(await fullCoa(coaId));
  } catch (e) { next(e); }
});

export default r;
