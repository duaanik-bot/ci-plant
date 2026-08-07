// PO Import — customer-PO PDF → parsed header + matched lines. Parse never
// writes; only alias learning, quick-create master, and the final POST /orders
// (existing route) touch the DB.
import { Router } from 'express';
import multer from 'multer';
import { q, one } from '../db.js';
import { audit, nextProductCode, placeholderBoardId } from '../helpers.js';
import { requireRole } from '../auth.js';
import { parsePO } from '../poparse.js';
import { normalize, scrub, matchLine } from '../pomatch.js';

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
  const lines = rawLines.map(l => {
    const m = matchLine(l.raw_text, products, aliases);
    return { ...l, match: { status: m.status, best: enrich(m.best), suggestions: m.suggestions.map(enrich) } };
  });
  await attachForeignMatches(customerId, lines);
  return lines;
}

// Products migrate between sister entities routinely (SGBT ↔ SGLS), so a line
// that matches NOTHING under the PO's customer gets one more look — against
// every other customer's catalogue. A hit is attached as `foreign`, labelled
// with its current owner, and is never auto-picked: acting on it migrates a
// master, so that stays a deliberate planner click in the wizard.
async function attachForeignMatches(customerId, lines) {
  // Anything short of a confident local match gets the second look — a WEAK
  // local suggestion must not hide the right product sitting under the sister
  // entity (ZIKDUCE's own carton under Biotech vs a 0.54 NICOWIN guess here).
  const misses = lines.filter(l => l.match.status !== 'matched');
  if (!misses.length) return;
  const foreign = await q(`
    SELECT p.id, p.name, p.code, p.rate, p.spec_incomplete, p.customer_id,
           p.party_item_code, p.party_artwork_code,
           c.name AS customer_name, COALESCE(p.gst_pct, gr.rate, 12) AS gst
    FROM products p
    JOIN customers c ON c.id = p.customer_id AND c.active=1
    LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
    WHERE p.customer_id <> $1 AND p.active=1`, [customerId]);
  if (!foreign.length) return;
  const info = Object.fromEntries(foreign.map(p => [p.id, p]));
  for (const l of misses) {
    // No aliases here: alias learning is per-owner and moves WITH a migration.
    const m = matchLine(l.raw_text, foreign, []);
    const pick = m.best ?? m.suggestions[0];
    const localTop = l.match.suggestions[0]?.confidence ?? 0;
    if (pick && pick.confidence >= 0.5 && pick.confidence > localTop) {
      l.match.foreign = { ...info[pick.product_id], product_id: pick.product_id, confidence: pick.confidence };
    }
  }
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
    // Key the alias on the scrubbed line — the same form matchLine looks up —
    // so learning survives the next PO's different delivery date.
    const alias_norm = normalize(scrub(alias_text));
    if (!customer_id || !alias_norm || !product_id) return res.status(400).json({ error: 'customer_id, alias_text and product_id required' });
    await q(`INSERT INTO product_aliases (customer_id, alias_norm, product_id) VALUES ($1,$2,$3)
             ON CONFLICT (customer_id, alias_norm) DO UPDATE SET product_id=EXCLUDED.product_id`,
      [customer_id, alias_norm, product_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const numOrNull = v => (v == null || v === '' ? null : +v);
const textOrNull = v => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};
const firstWordGrade = board => {
  const name = String(board?.name || '');
  if (!name || /unspecified/i.test(name)) return null;
  return name.split(/[ ·]+/).filter(Boolean)[0] || null;
};
const gsmFromBoard = board => {
  const fromColumn = numOrNull(board?.gsm);
  if (fromColumn != null) return Math.round(fromColumn);
  const m = String(board?.name || board?.spec || '').match(/\b(\d{2,4})\s*GSM\b/i);
  return m ? +m[1] : null;
};
const specStillOpen = body => {
  const needed = ['size', 'board_grade', 'gsm', 'child_l', 'child_w'];
  return needed.some(k => body[k] == null || body[k] === '' || body[k] === 0);
};

// Quick-create master from an unmatched PO line: pre-filled from the parsed PDF,
// editable in the import modal, and saved as a real product master immediately.
r.post('/orders/import/quick-product', canPlan, async (req, res, next) => {
  try {
    const {
      customer_id, name, rate, product_type, gst_pct, code,
      party_item_code, party_artwork_code, board_material_id, board_grade, gsm,
      size, child_l, child_w, parent_l, parent_w, ups, colors, colour_type,
      coating, spec_incomplete,
    } = req.body;
    if (!customer_id || !name?.trim()) return res.status(400).json({ error: 'Customer and name required' });
    let board = null;
    if (board_material_id) {
      board = await one(`SELECT id, name, spec, grade, gsm FROM materials WHERE id=$1 AND category='board'`, [board_material_id]);
      if (!board) return res.status(400).json({ error: 'Selected board was not found' });
    } else {
      const boardId = await placeholderBoardId(one);
      if (!boardId) return res.status(400).json({ error: 'Create a board material first' });
      board = await one('SELECT id, name, spec, grade, gsm FROM materials WHERE id=$1', [boardId]);
    }
    const internalCode = textOrNull(code) || await nextProductCode(+customer_id);
    const body = {
      board_grade: textOrNull(board_grade) || board?.grade || firstWordGrade(board),
      gsm: numOrNull(gsm) != null ? Math.round(numOrNull(gsm)) : gsmFromBoard(board),
      size: textOrNull(size),
      child_l: numOrNull(child_l), child_w: numOrNull(child_w),
      parent_l: numOrNull(parent_l), parent_w: numOrNull(parent_w),
    };
    const incomplete = spec_incomplete == null || spec_incomplete === ''
      ? (specStillOpen(body) ? 1 : 0)
      : (+spec_incomplete ? 1 : 0);
    const [p] = await q(`
      INSERT INTO products (
        customer_id, name, code, internal_carton_code, party_item_code, party_artwork_code,
        board_material_id, board_name, board_grade, gsm, size, child_l, child_w, parent_l, parent_w,
        ups, colors, colour_type, coating, rate, product_type, gst_pct, spec_incomplete, active
      )
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,1)
      RETURNING *`,
      [customer_id, name.trim(), internalCode, textOrNull(party_item_code), textOrNull(party_artwork_code),
       board.id, /unspecified/i.test(board?.name || '') ? null : board?.name || null,
       body.board_grade, body.gsm, body.size, body.child_l, body.child_w, body.parent_l, body.parent_w,
       numOrNull(ups) ?? 1, numOrNull(colors) ?? 4, textOrNull(colour_type) || 'CMYK', textOrNull(coating),
       numOrNull(rate) ?? 0, textOrNull(product_type), numOrNull(gst_pct), incomplete]);
    await audit('product', p.id, 'create', `quick-create from PO import: ${p.name}`, q, req.user.name);
    const full = await one(`
      SELECT p.*, COALESCE(p.gst_pct, gr.rate, 12) AS gst
      FROM products p LEFT JOIN gst_rates gr ON gr.product_type=p.product_type WHERE p.id=$1`, [p.id]);
    res.json(full);
  } catch (e) { next(e); }
});

export default r;
