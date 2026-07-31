// PO Import — customer-PO PDF → parsed header + matched lines. Parse never
// writes; only alias learning, quick-create master, and the final POST /orders
// (existing route) touch the DB.
import { Router } from 'express';
import multer from 'multer';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';
import { parsePO } from '../poparse.js';
import { normalize, matchLine } from '../pomatch.js';

const r = Router();
const canPlan = requireRole('planner');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}\b/g;
const OWN_GSTIN = '03AABCC1234D1Z5'; // Colour Impressions — never "detect" ourselves

async function detectCustomer(headerText) {
  const customers = await q('SELECT id, name, gstin FROM customers WHERE active=1');
  const gstins = (headerText.match(GSTIN_RE) || []).filter(g => g !== OWN_GSTIN);
  const byGstin = customers.find(c => c.gstin && gstins.includes(c.gstin.toUpperCase()));
  if (byGstin) return { customer_id: byGstin.id, candidates: [{ id: byGstin.id, name: byGstin.name, confidence: 1 }] };
  const headTokens = new Set(normalize(headerText).split(' '));
  // Generic company words shouldn't make "Cipla Ltd" a candidate for every
  // PO that says "Ltd" somewhere.
  const STOP = new Set(['LTD', 'LIMITED', 'PVT', 'PRIVATE', 'INDIA', 'CO', 'COMPANY', 'INDUSTRIES', 'ENTERPRISES', 'CORP', 'INC', 'LLP']);
  const scored = customers
    .map(c => {
      const all = normalize(c.name).split(' ').filter(Boolean);
      const distinct = all.filter(t => !STOP.has(t));
      const nameTokens = distinct.length ? distinct : all;
      const hit = nameTokens.filter(t => headTokens.has(t)).length;
      return { id: c.id, name: c.name, confidence: nameTokens.length ? Math.round((hit / nameTokens.length) * 100) / 100 : 0 };
    })
    .filter(c => c.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  return { customer_id: scored[0]?.confidence >= 0.6 ? scored[0].id : null, candidates: scored };
}

async function matchAll(customerId, rawLines) {
  const products = await q(`
    SELECT p.id, p.name, p.code, p.rate, p.spec_incomplete,
           p.party_item_code, p.party_artwork_code,
           COALESCE(p.gst_pct, gr.rate, 12) AS gst
    FROM products p LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
    WHERE p.customer_id=$1 AND p.active=1`, [customerId]);
  const aliases = await q('SELECT alias_norm, product_id FROM product_aliases WHERE customer_id=$1', [customerId]);
  const info = Object.fromEntries(products.map(p => [p.id, p]));
  const enrich = s => (s ? {
    ...s,
    name: info[s.product_id]?.name, code: info[s.product_id]?.code,
    rate: info[s.product_id]?.rate, gst: info[s.product_id]?.gst,
    spec_incomplete: info[s.product_id]?.spec_incomplete,
    party_item_code: info[s.product_id]?.party_item_code,
    party_artwork_code: info[s.product_id]?.party_artwork_code,
  } : null);
  return rawLines.map(l => {
    const m = matchLine(l.raw_text, products, aliases);
    return { ...l, match: { status: m.status, best: enrich(m.best), suggestions: m.suggestions.map(enrich) } };
  });
}

r.post('/orders/import/parse', canPlan, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!req.file.buffer.subarray(0, 5).toString().startsWith('%PDF')) {
      return res.status(400).json({ error: 'That file is not a PDF' });
    }
    let parsed;
    try { parsed = await parsePO(req.file.buffer); }
    catch (e) {
      // Never blame the planner's file for a fault of ours. pdfjs names the two
      // failures that really are the file; anything else (PDF engine missing
      // from the serverless bundle, out of memory) is a server bug and has to
      // reach the logs as a 500. This catch used to discard the reason and call
      // everything "corrupt", which hid a total import outage in production —
      // every PO rejected, nothing logged, and the message pointed at the file.
      console.error('[po-import] parse failed:', e);
      if (e?.name === 'PasswordException') {
        return res.status(422).json({ error: 'This PDF is password-protected — ask the customer for an unlocked copy.' });
      }
      if (e?.name === 'InvalidPDFException') {
        return res.status(422).json({ error: 'Could not read this PDF — it may be corrupt' });
      }
      return next(e);
    }
    if (parsed.scanned) {
      return res.status(422).json({ code: 'scanned', error: "This looks like a scanned copy — text extraction isn't possible. Ask for the original digital PDF." });
    }
    const { customer_id, candidates } = await detectCustomer(parsed.header_text);
    const lines = customer_id
      ? await matchAll(customer_id, parsed.lines)
      : parsed.lines.map(l => ({ ...l, match: { status: 'none', best: null, suggestions: [] } }));
    const warnings = [];
    if (!parsed.lines.length) warnings.push('No item table detected — add lines manually.');
    if (!customer_id) warnings.push('Customer not recognized — pick one to run matching.');
    res.json({
      customer_id, customer_candidates: candidates,
      po_number: parsed.po_number, po_date: parsed.po_date, delivery_date: parsed.delivery_date,
      lines, warnings,
    });
  } catch (e) { next(e); }
});

r.post('/orders/import/rematch', canPlan, async (req, res, next) => {
  try {
    const { customer_id, lines } = req.body;
    if (!customer_id || !Array.isArray(lines)) return res.status(400).json({ error: 'customer_id and lines required' });
    res.json({ lines: await matchAll(customer_id, lines) });
  } catch (e) { next(e); }
});

r.post('/orders/import/alias', canPlan, async (req, res, next) => {
  try {
    const { customer_id, alias_text, product_id } = req.body;
    const alias_norm = normalize(alias_text);
    if (!customer_id || !alias_norm || !product_id) return res.status(400).json({ error: 'customer_id, alias_text and product_id required' });
    await q(`INSERT INTO product_aliases (customer_id, alias_norm, product_id) VALUES ($1,$2,$3)
             ON CONFLICT (customer_id, alias_norm) DO UPDATE SET product_id=EXCLUDED.product_id`,
      [customer_id, alias_norm, product_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Quick-create master from an unmatched PO line: real name/rate/GST, placeholder
// board + spec, flagged spec_incomplete so Masters shows it and planning
// readiness keeps it out of production until completed.
r.post('/orders/import/quick-product', canPlan, async (req, res, next) => {
  try {
    const { customer_id, name, rate, product_type, gst_pct, board_grade, gsm } = req.body;
    if (!customer_id || !name?.trim()) return res.status(400).json({ error: 'Customer and name required' });
    const board = await one(`SELECT id FROM materials WHERE category='board' AND COALESCE(leftover,0)=0 ORDER BY id LIMIT 1`);
    if (!board) return res.status(400).json({ error: 'Create a board material first' });
    const seq = await one('SELECT COALESCE(MAX(id),0)+1 AS n FROM products');
    const code = `NEW-${String(seq.n).padStart(4, '0')}`;
    // Board grade + GSM are captured up front when the PO carries them (or the
    // planner fills them), so Smart Match can lean on them straight away.
    const [p] = await q(`
      INSERT INTO products (customer_id, name, code, board_material_id, board_grade, gsm, ups, rate, product_type, gst_pct, spec_incomplete, active)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,1,1) RETURNING *`,
      [customer_id, name.trim(), code, board.id, board_grade?.trim() || null,
       gsm != null && gsm !== '' ? Math.round(+gsm) : null, rate ?? 0, product_type || null, gst_pct ?? null]);
    await audit('product', p.id, 'create', `quick-create from PO import: ${p.name}`, q, req.user.name);
    const full = await one(`
      SELECT p.*, COALESCE(p.gst_pct, gr.rate, 12) AS gst
      FROM products p LEFT JOIN gst_rates gr ON gr.product_type=p.product_type WHERE p.id=$1`, [p.id]);
    res.json(full);
  } catch (e) { next(e); }
});

export default r;
