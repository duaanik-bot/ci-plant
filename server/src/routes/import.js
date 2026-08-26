// PO Import — customer-PO PDF → parsed header + matched lines. Parse never
// writes; only alias learning, quick-create master, and the final POST /orders
// (existing route) touch the DB.
import { Router } from 'express';
import multer from 'multer';
import { q, one } from '../db.js';
import { audit, nextProductCode, placeholderBoardId } from '../helpers.js';
import { requireRole } from '../auth.js';
import { parsePO, parseFromRows, rowsFromItems, ocrPagesToItems } from '../poparse.js';
import { cleanOcrPages } from '../ocr-words.js';
import { normalize, scrub, matchLine } from '../pomatch.js';

const r = Router();
const canPlan = requireRole('planner');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}\b/g;
// Our own registrations — a PO header carries the seller's GSTIN as well as the
// buyer's, and detecting ourselves would name the plant as its own customer.
// Both entities are listed: a Galpha PO is addressed to Darbi Print Pack.
// The placeholder that sat here was not a valid GSTIN at all (its check digit
// did not compute), so it never matched anything and never filtered anything.
const OWN_GSTINS = new Set(['03BCMPD4475P1Z7', '03AXRPD1246K2ZI']);

async function detectCustomer(headerText) {
  const customers = await q('SELECT id, name, gstin FROM customers WHERE active=1');
  const gstins = (headerText.match(GSTIN_RE) || []).filter(g => !OWN_GSTINS.has(g.toUpperCase()));
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

// Shared by the text-layer route and the OCR route: once there are parsed lines
// it makes no difference where the characters came from, and the two paths must
// not be allowed to drift into answering differently.
async function buildImportResult(parsed, seedWarnings = []) {
  const { customer_id, candidates } = await detectCustomer(parsed.header_text);
  const lines = customer_id
    ? await matchAll(customer_id, parsed.lines)
    : parsed.lines.map(l => ({ ...l, match: { status: 'none', best: null, suggestions: [] } }));
  const warnings = [...seedWarnings];
  if (!parsed.lines.length) warnings.push('No item table detected — add lines manually.');
  if (!customer_id) warnings.push('Customer not recognized — pick one to run matching.');
  // Every line the columnar reader produces carries the amount the document
  // printed for it, so the line's own arithmetic can be checked against the
  // page. A mismatch is the one signal that a figure was read out of the
  // wrong column, and it is worth far more to the planner than a silent
  // number: a wrong quantity here becomes a wrong board order downstream.
  // On the OCR route it does double duty: it is also the check that catches a
  // misread digit, which is the failure mode that matters there.
  const offBy = parsed.lines
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => l.reconciled === false);
  if (offBy.length) {
    warnings.push(offBy.length === parsed.lines.length
      ? `None of the ${offBy.length} lines add up against the amounts printed on the PO — check every quantity and rate before saving.`
      : `Check line${offBy.length > 1 ? 's' : ''} ${offBy.map(o => o.n).join(', ')} — quantity × rate does not match the amount printed on the PO.`);
  }
  return {
    reader: parsed.reader ?? null,
    customer_id, customer_candidates: candidates,
    po_number: parsed.po_number, po_date: parsed.po_date, delivery_date: parsed.delivery_date,
    lines, warnings,
  };
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
    // A scanned PO used to end the import here, with a 422 the wizard turned
    // into a toast and nothing else — the planner was bounced out of the flow
    // and had to key the whole order somewhere else. There is still no text to
    // read, but the wizard itself (customer detection aside) is the fastest way
    // to key an order in, so open it empty and say plainly what happened.
    if (parsed.scanned) {
      return res.json({
        scanned: true, code: 'scanned',
        customer_id: null, customer_candidates: [],
        po_number: null, po_date: null, delivery_date: null, lines: [],
        warnings: ["This is a scanned copy — nothing could be read from it. Pick the customer and key the lines in below, or ask for the original digital PDF."],
      });
    }
    res.json(await buildImportResult(parsed));
  } catch (e) { next(e); }
});

// A scanned PO has no text layer to read, so the CLIENT renders each page with
// pdfjs and OCRs it, and posts the word boxes here. The server does not trust
// the client to have understood the table — it re-runs the identical row
// bucketing, heading model and columnar reader that a digital PO goes through,
// so the two paths cannot diverge in what they consider a line.
//
// Deliberately NOT done on the server: rendering a page needs a canvas, which
// on Vercel means a native dependency, and OCR of three A4 pages runs well past
// the function's 30s ceiling. The planner's own machine has both, for free.
const OCR_MAX_PAGES = 40;
const OCR_MAX_WORDS = 60000;

r.post('/orders/import/parse-ocr', canPlan, async (req, res, next) => {
  try {
    const pages = req.body?.pages;
    if (!Array.isArray(pages) || !pages.length) {
      return res.status(400).json({ error: 'pages required' });
    }
    if (pages.length > OCR_MAX_PAGES) {
      return res.status(413).json({ error: `That PDF has more than ${OCR_MAX_PAGES} pages` });
    }
    const words = pages.reduce((n, p) => n + (Array.isArray(p?.words) ? p.words.length : 0), 0);
    if (!words) return res.status(422).json({ code: 'ocr_empty', error: 'Nothing could be read off this scan.' });
    if (words > OCR_MAX_WORDS) return res.status(413).json({ error: 'That scan produced too much text to import' });

    // Repair the engine's tokens before anything geometric is read off them —
    // rules glued onto figures, cells welded together, glyphs read twice.
    const rows = rowsFromItems(ocrPagesToItems(cleanOcrPages(pages)));
    // No shape fallback here — see parseFromRows. On OCR output the fallback
    // reader would answer with a confident wrong quantity far more often than
    // it would answer correctly, and there is no way for the planner to tell.
    const parsed = parseFromRows(rows, { allowShapeFallback: false });
    if (!parsed.lines.length) {
      return res.status(422).json({
        code: 'ocr_no_table',
        error: 'The scan was read, but no item table could be made out in it. Key the lines in by hand.',
      });
    }
    // Say it once, at the top, and make it the loudest thing in the list: every
    // figure below was guessed from pixels. The per-line arithmetic check that
    // buildImportResult adds is what turns that from a plea into a pointer.
    res.json({
      ...await buildImportResult(parsed, ['Read by OCR from a scanned copy — check every code, quantity and rate against the PDF before saving.']),
      ocr: true,
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
  const needed = ['size', 'board_grade', 'gsm', 'child_l', 'child_w', 'ups'];
  return needed.some(k => body[k] == null || body[k] === '' || body[k] === 0);
};
const splitSize2 = value => {
  const m = String(value ?? '').replace(/[×]/g, 'x').match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  return m ? { l: +m[1], w: +m[2] } : null;
};

// Quick-create master from an unmatched PO line: pre-filled from the parsed PDF,
// editable in the import modal, and saved as a real product master immediately.
r.post('/orders/import/quick-product', canPlan, async (req, res, next) => {
  try {
    const {
      customer_id, name, rate, product_type, gst_pct, code,
      party_item_code, party_artwork_code, board_material_id, board_grade, gsm,
      size, child_l, child_w, parent_l, parent_w, ups, colors, colour_type,
      coating, pasting_type, die_number, tool_id, sheet_size, spec_incomplete,
    } = req.body;
    if (!customer_id || !name?.trim()) return res.status(400).json({ error: 'Customer and name required' });
    let die = null;
    if (tool_id) {
      die = await one(`SELECT id, code, ups, sheet_size, carton_size FROM tools WHERE id=$1 AND family='die' AND active=1`, [tool_id]);
      if (!die) return res.status(400).json({ error: 'Selected die was not found' });
    }
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
    const dieSheet = splitSize2(sheet_size) || splitSize2(die?.sheet_size);
    const body = {
      board_grade: textOrNull(board_grade) || board?.grade || firstWordGrade(board),
      gsm: numOrNull(gsm) != null ? Math.round(numOrNull(gsm)) : gsmFromBoard(board),
      size: textOrNull(size) || textOrNull(die?.carton_size),
      child_l: numOrNull(child_l) ?? dieSheet?.l ?? null,
      child_w: numOrNull(child_w) ?? dieSheet?.w ?? null,
      parent_l: numOrNull(parent_l), parent_w: numOrNull(parent_w),
      ups: numOrNull(ups) ?? numOrNull(die?.ups),
    };
    const incomplete = spec_incomplete == null || spec_incomplete === ''
      ? (specStillOpen(body) ? 1 : 0)
      : (+spec_incomplete ? 1 : 0);
    const [p] = await q(`
      INSERT INTO products (
        customer_id, name, code, internal_carton_code, party_item_code, party_artwork_code,
        board_material_id, board_name, board_grade, gsm, size, child_l, child_w, parent_l, parent_w,
        ups, colors, colour_type, coating, pasting_type, die_number, tool_id,
        rate, product_type, gst_pct, spec_incomplete, active
      )
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,1)
      RETURNING *`,
      [customer_id, name.trim(), internalCode, textOrNull(party_item_code), textOrNull(party_artwork_code),
       board.id, /unspecified/i.test(board?.name || '') ? null : board?.name || null,
       body.board_grade, body.gsm, body.size, body.child_l, body.child_w, body.parent_l, body.parent_w,
       body.ups ?? 1, numOrNull(colors) ?? 4, textOrNull(colour_type) || 'CMYK', textOrNull(coating),
       textOrNull(pasting_type), textOrNull(die_number) || textOrNull(die?.code), die?.id ?? null,
       numOrNull(rate) ?? 0, textOrNull(product_type), numOrNull(gst_pct), incomplete]);
    await audit('product', p.id, 'create', `quick-create from PO import: ${p.name}`, q, req.user.name);
    const full = await one(`
      SELECT p.*, COALESCE(p.gst_pct, gr.rate, 12) AS gst
      FROM products p LEFT JOIN gst_rates gr ON gr.product_type=p.product_type WHERE p.id=$1`, [p.id]);
    res.json(full);
  } catch (e) { next(e); }
});

export default r;
