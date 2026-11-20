// Costing — new-product costing, worked out by server/src/costing-engine.js (the plant's cost sheet),
// saved with every revision, checked against the Size Library and the Die Master, and compared with
// earlier costings of the same size.
//
//   GET  /costing/bootstrap              defaults, coating factors, board grades with today's ₹/kg
//   GET  /costing/size-check?size=&exclude=   library entries, dies (Die Master + the die list), earlier costings and the stocked sheets for one size
//   POST /costing/size-check/bulk        the same, summarised, for the rows of a bulk costing
//   GET  /costing/products?search=       Product Master entries to start a costing from
//   GET  /costing/costings               the register (filters below); GET /costing/costings/:id one, with revisions
//   POST /costing/costings               a new costing        PUT /costing/costings/:id  a revision
//   POST /costing/costings/:id/archive   hide / show again
//   GET  /costing/batches · GET /costing/batches/:id · POST /costing/batches (new) · POST /costing/batches/:id/save
//   GET  /costing/sizes · POST /costing/sizes · PUT /costing/sizes/:id · GET /costing/sizes/duplicates
//   PUT  /costing/settings               defaults, coating names, alert % (admins)
//   POST /costing/costings/:id/approve · POST /costing/batches/:id/approve   (the Management right)
//   POST /costing/products/match         Product Master entries for names pasted into a bulk costing
//   POST /costing/enquiries/auto-cost    "Cost it for me": the ticked enquiries costed by CI Plant, as Auto drafts
//
// The database helpers (save, revise, approve, read, size check) and what a costing is made of (costingFrom) live in
// server/src/costing-store.js, which the enquiry desk's auto-costing (server/src/auto-costing.js) shares (20 Nov 2026).
// The figures are ALWAYS worked out here on save — whatever the browser showed is not trusted.
// Audit lines carry the costing number and what happened, never a price: the audit log is read by
// every login (Timeline).
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, lockDocNumber, optionalText } from '../helpers.js';
import { parseSize, normStyle, num, CURRENT_FORMULA, FORMULAS, STYLES } from '../costing-engine.js';
import { possibleDuplicates, sizeEntryKey } from '../costing-sheet.js';
import { matchDies, mayCost, mayEditCostingRates, mayApproveCosting } from '../costing-match.js';
import {
  COSTING_COLS, ENTRY_COLS, USAGE, PRODUCT_COLS, boardGrades, typicalFigures, allDies, sizeCheck, insertCosting, reviseCosting,
  approveCosting, costingById, costingFrom, cleanInputs,
} from '../costing-store.js';
import { cleanCustomerRates } from '../../../client/src/lib/costingRules.js';
import { linkEnquiry, unlinkCosting, newGroup } from './enquiries.js';
import { autoCostPending } from '../auto-costing.js';

export { cleanInputs };

const r = Router();

const loginOf = req => one('SELECT id, name, role, active, modules, is_management FROM users WHERE id = $1 AND active = 1', [req.user?.id]);
const fail = (status, error) => Object.assign(new Error(error), { status });

// Every /costing route: the Costing tick, read fresh (ticks change mid-session; the token does not).
r.use('/costing', async (req, res, next) => {
  try {
    const u = await loginOf(req);
    if (!mayCost(u)) {
      return res.status(403).json({ error: 'Costing is not ticked for this login — ask an admin to tick it in Masters → Users.', code: 'COSTING_REFUSED' });
    }
    req.costingUser = u;
    next();
  } catch (e) { next(e); }
});

const text = (v, max = 300) => optionalText(v)?.slice(0, max) ?? null;
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);

r.get('/costing/bootstrap', async (req, res, next) => {
  try {
    const settings = await one('SELECT defaults, coatings, alert_pct::float8 AS alert_pct, customer_rates FROM costing_settings WHERE id = 1');
    res.json({
      settings: settings || { defaults: {}, coatings: [], alert_pct: 15, customer_rates: [] },
      typical: await typicalFigures(),
      can_approve: mayApproveCosting(req.costingUser),
      board_grades: await boardGrades(),
      formulas: Object.entries(FORMULAS).map(([key, f]) => ({ key, label: f.label })),
      current_formula: CURRENT_FORMULA,
      styles: Object.entries(STYLES).map(([key, label]) => ({ key, label })),
      can_edit_rates: mayEditCostingRates(req.costingUser),
    });
  } catch (e) { next(e); }
});

// ── size check ───────────────────────────────────────────────────────────────────────────────────
r.get('/costing/size-check', async (req, res, next) => {
  try {
    res.json(await sizeCheck(req.query.size, { excludeId: req.query.exclude }));
  } catch (e) { next(e); }
});

// A bulk costing's rows, in one round trip: per size, the library layouts (most used first), how many
// dies match, and the newest earlier costing.
r.post('/costing/size-check/bulk', async (req, res, next) => {
  try {
    const texts = Array.isArray(req.body?.sizes) ? req.body.sizes.slice(0, 200) : [];
    const sizes = new Map();
    for (const t of texts) { const s = parseSize(t); if (s) sizes.set(s.key, s); }
    if (!sizes.size) return res.json({});
    const keys = [...sizes.keys()];
    const entries = await q(`SELECT ${ENTRY_COLS}, ${USAGE} FROM costing_sizes s
                              WHERE s.active AND s.size_key = ANY($1::text[])`, [keys]);
    const last = await q(`SELECT DISTINCT ON (c.size_key) c.size_key, c.costing_no, to_char(c.costed_on, 'YYYY-MM-DD') AS costed_on,
                                 c.cost_per_unit::float8 AS cost_per_unit, c.customer_name, c.product_name
                            FROM costings c
                           WHERE c.size_key = ANY($1::text[]) AND NOT c.archived AND c.complete
                           ORDER BY c.size_key, c.costed_on DESC NULLS LAST, c.id DESC`, [keys]);
    const counts = await q(`SELECT size_key, count(*)::int AS n FROM costings
                             WHERE size_key = ANY($1::text[]) AND NOT archived AND complete GROUP BY size_key`, [keys]);
    const dies = await allDies();
    const out = {};
    for (const [key, size] of sizes) {
      const m = matchDies(size, dies);
      out[key] = {
        size,
        library: entries.filter(e => e.size_key === key).sort((a, b) => b.times_costed - a.times_costed),
        dies_exact: m.exact.map(d => ({ code: d.code, ups: d.ups, carton_size: d.carton_size, condition: d.condition })),
        dies_near: m.near.length,
        history_count: counts.find(c => c.size_key === key)?.n || 0,
        last: last.find(l => l.size_key === key) || null,
      };
    }
    res.json(out);
  } catch (e) { next(e); }
});

// What a costing takes from a Product Master entry: PRODUCT_COLS (costing-store.js).
r.get('/costing/products', async (req, res, next) => {
  try {
    const s = text(req.query.search, 80);
    if (!s) return res.json([]);
    const rows = await q(`
      SELECT ${PRODUCT_COLS}
        FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.active = 1 AND (p.name ILIKE $1 OR p.code ILIKE $1 OR p.size ILIKE $1 OR cu.name ILIKE $1
             OR p.party_item_code ILIKE $1)
       ORDER BY (lower(p.code) = lower($2) OR lower(p.name) = lower($2)) DESC, p.name LIMIT 25`, [`%${s}%`, s]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Names (or codes) pasted into a bulk costing, each matched to ONE active Product Master entry by its
// exact name or code, case and spacing aside. A name two products share is left unmatched: a guess
// would cost the wrong carton.
r.post('/costing/products/match', async (req, res, next) => {
  try {
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).map(n => text(n, 200)).filter(Boolean).slice(0, 200);
    if (!names.length) return res.json({});
    const keys = [...new Set(names.map(n => n.toLowerCase().replace(/\s+/g, ' ')))];
    const rows = await q(`
      SELECT ${PRODUCT_COLS}, lower(regexp_replace(p.name, '\\s+', ' ', 'g')) AS name_key, lower(p.code) AS code_key
        FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
       WHERE p.active = 1 AND (lower(regexp_replace(p.name, '\\s+', ' ', 'g')) = ANY($1::text[]) OR lower(p.code) = ANY($1::text[]))`, [keys]);
    const out = {};
    for (const k of keys) {
      const hits = rows.filter(r => r.name_key === k || r.code_key === k);
      if (hits.length === 1) { const { name_key, code_key, ...p } = hits[0]; out[k] = p; }
    }
    res.json(out);
  } catch (e) { next(e); }
});

// ── saving ───────────────────────────────────────────────────────────────────────────────────────
// What a costing is made of, read from a request body: costingFrom (costing-store.js). The figures are worked out there.
r.post('/costing/costings', async (req, res, next) => {
  try {
    const c = costingFrom(req.body);
    // Pushed from the enquiry desk: the costing is linked to its enquiry in the same transaction.
    let desk = null;
    const row = await tx(async (qc, oc) => {
      const made = await insertCosting(c, { note: text(req.body?.note, 300) }, qc, oc, req.costingUser);
      desk = await linkEnquiry(qc, req.body?.enquiry_id, made, null, req.costingUser);
      return made;
    });
    res.status(201).json({ ...(await costingById(row.id)), desk });
  } catch (e) { next(e); }
});

r.put('/costing/costings/:id', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id);
    if (!id) throw fail(404, 'No such costing.');
    const c = costingFrom(req.body);
    let desk = null;
    await tx(async (qc, oc) => {
      const done = await reviseCosting(id, c, { note: text(req.body?.note, 300) }, qc, oc, req.costingUser);
      desk = await linkEnquiry(qc, req.body?.enquiry_id, done, null, req.costingUser);
    });
    res.json({ ...(await costingById(id)), desk });
  } catch (e) { next(e); }
});

// "Cost it for me" (the desk's To cost tab): the ticked enquiries costed by CI Plant as Auto drafts, as the automatic run
// costs a filed item — a row with no costing, or one whose auto-costing is still incomplete (after a person set its size or
// pasting). A row a person costed is left as it is, with the reason. Always the ticked rows: no ids, nothing costed.
r.post('/costing/enquiries/auto-cost', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json(await autoCostPending({ ids, force: true, budgetMs: 20000 }));
  } catch (e) { next(e); }
});

r.get('/costing/costings/:id', async (req, res, next) => {
  try {
    const c = await costingById(intOrNull(req.params.id) || 0);
    if (!c) throw fail(404, 'No such costing.');
    res.json(c);
  } catch (e) { next(e); }
});

r.post('/costing/costings/:id/approve', async (req, res, next) => {
  try {
    if (!mayApproveCosting(req.costingUser)) throw fail(403, 'Approving a costing needs the Management right.');
    const id = intOrNull(req.params.id) || 0;
    await tx((qc, oc) => approveCosting(id, req.costingUser, qc, oc));
    res.json(await costingById(id));
  } catch (e) { next(e); }
});

// Every complete row of a batch, approved together. Rows still being filled in are left as Draft.
r.post('/costing/batches/:id/approve', async (req, res, next) => {
  try {
    if (!mayApproveCosting(req.costingUser)) throw fail(403, 'Approving a costing needs the Management right.');
    const id = intOrNull(req.params.id) || 0;
    const done = await tx(async (qc, oc) => {
      const rows = await qc(`SELECT id FROM costings WHERE batch_id = $1 AND NOT archived AND complete AND status = 'draft' ORDER BY id`, [id]);
      for (const r of rows) await approveCosting(r.id, req.costingUser, qc, oc);
      return rows.length;
    });
    res.json({ approved: done, batch: await batchById(id) });
  } catch (e) { next(e); }
});

r.post('/costing/costings/:id/archive', async (req, res, next) => {
  try {
    const archived = req.body?.archived !== false;
    const row = await one(`UPDATE costings SET archived = $2, updated_at = now(), updated_by = $3, updated_by_name = $4
                            WHERE id = $1 RETURNING id, costing_no`,
    [intOrNull(req.params.id) || 0, archived, req.costingUser.id, req.costingUser.name]);
    if (!row) throw fail(404, 'No such costing.');
    await audit('costing', row.id, archived ? 'archive' : 'unarchive', row.costing_no, q, req.costingUser.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Consolidate copies (owner, 11 Nov 2026: "button to be consolidation for revision … give option to undo").
// Several costings of the same product made by mistake fold into ONE: the costing kept stays as it is (the
// one an enquiry carries, else the oldest), and the copies are hidden with a note naming it. A copy linked
// to an enquiry is refused — that link is the enquiry's costing. Undo shows the copies again.
const MERGED = /^\[Merged into (CI-CST-\d+)\] ?/;
r.post('/costing/costings/merge', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const list = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(intOrNull).filter(Boolean))].slice(0, 100);
    if (list.length < 2) throw fail(400, 'Tick two or more costings of the same product.');
    const out = await tx(async (qc, oc) => {
      const rows = await qc(`SELECT c.id, c.costing_no, c.source, c.archived, c.product_name, c.remarks, c.created_at,
                                    (SELECT array_agg(e.enquiry_no ORDER BY e.id) FROM enquiries e WHERE e.costing_id = c.id
                                       AND e.status NOT IN ('dropped')) AS enquiries
                               FROM costings c WHERE c.id = ANY($1::int[]) ORDER BY c.id FOR UPDATE`, [list]);
      if (rows.length !== list.length) throw fail(404, 'A costing ticked was not found — refresh and try again.');
      if (rows.some(x => x.source !== 'erp')) throw fail(409, 'Old cost-sheet rows are kept as the sheet had them — tick costings made here only.');
      const names = new Set(rows.map(x => String(x.product_name || '').trim().toLowerCase().replace(/\s+/g, ' ')));
      if (names.size > 1) throw fail(409, 'These are different products — consolidate copies of ONE product at a time.');
      const wanted = intOrNull(req.body?.keep_id);
      const linked = rows.filter(x => x.enquiries?.length);
      if (linked.length > 1) throw fail(409, `${linked.map(x => x.costing_no).join(' and ')} each answer an enquiry — keep one of them on its enquiry first.`);
      const keep = rows.find(x => x.id === wanted) || linked[0] || rows.filter(x => !x.archived)[0] || rows[0];
      if (linked.length && linked[0].id !== keep.id) throw fail(409, `${linked[0].costing_no} answers ${linked[0].enquiries.join(', ')} — keep that one.`);
      const hidden = [];
      for (const x of rows) {
        if (x.id === keep.id) continue;
        const remarks = `[Merged into ${keep.costing_no}] ${String(x.remarks || '').replace(MERGED, '')}`.trim().slice(0, 1000);
        await qc(`UPDATE costings SET archived = true, remarks = $2, updated_at = now(), updated_by = $3, updated_by_name = $4 WHERE id = $1`,
          [x.id, remarks, u.id, u.name]);
        await audit('costing', x.id, 'merge', `${x.costing_no} into ${keep.costing_no}`, qc, u.name);
        hidden.push({ id: x.id, costing_no: x.costing_no, was_hidden: x.archived });
      }
      if (keep.archived) await qc('UPDATE costings SET archived = false, updated_at = now(), updated_by = $2, updated_by_name = $3 WHERE id = $1', [keep.id, u.id, u.name]);
      return { kept: { id: keep.id, costing_no: keep.costing_no }, hidden };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Undo a consolidation: each copy still carrying the note comes back as it was (shown again, note off).
r.post('/costing/costings/unmerge', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const items = (Array.isArray(req.body?.hidden) ? req.body.hidden : []).slice(0, 100);
    const back = await tx(async (qc) => {
      const done = [];
      for (const it of items) {
        const id = intOrNull(it?.id);
        if (!id) continue;
        const x = await qc('SELECT id, costing_no, remarks FROM costings WHERE id = $1 FOR UPDATE', [id]).then(rs => rs[0]);
        if (!x || !MERGED.test(x.remarks || '')) continue;
        await qc(`UPDATE costings SET archived = $2, remarks = NULLIF($3, ''), updated_at = now(), updated_by = $4, updated_by_name = $5 WHERE id = $1`,
          [id, !!it.was_hidden, String(x.remarks).replace(MERGED, ''), u.id, u.name]);
        await audit('costing', id, 'unmerge', x.costing_no, qc, u.name);
        done.push(x.costing_no);
      }
      return done;
    });
    res.json({ back });
  } catch (e) { next(e); }
});

// The register. Filters: search (number, product, customer, size), source (erp | sheet), from / to
// (YYYY-MM-DD), flag (incomplete | not_reproduced | sheet_notes | no_size), archived=1 to see hidden.
r.get('/costing/costings', async (req, res, next) => {
  try {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    where.push(req.query.archived === '1' ? 'c.archived' : 'NOT c.archived');
    const s = text(req.query.search, 80);
    if (s) {
      const sizeKey = parseSize(s)?.key;
      args.push(`%${s}%`);
      const p = `$${args.length}`;
      if (sizeKey) { args.push(sizeKey); where.push(`(c.size_key = $${args.length} OR c.product_name ILIKE ${p} OR c.customer_name ILIKE ${p} OR c.costing_no ILIKE ${p})`); }
      else where.push(`(c.product_name ILIKE ${p} OR c.customer_name ILIKE ${p} OR c.costing_no ILIKE ${p} OR c.size_text ILIKE ${p})`);
    }
    if (['erp', 'sheet'].includes(req.query.source)) add('c.source = ?', req.query.source);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) add('c.costed_on >= ?::date', req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) add('c.costed_on <= ?::date', req.query.to);
    if (req.query.customer) add('c.customer_name ILIKE ?', `%${text(req.query.customer, 80)}%`);
    if (req.query.batch) add('c.batch_id = ?', intOrNull(req.query.batch) || 0);
    const flag = req.query.flag;
    if (flag === 'incomplete') where.push('NOT c.complete');
    if (flag === 'not_reproduced') where.push('c.reproduced = false');
    if (flag === 'sheet_notes') where.push("jsonb_array_length(c.notes) > 0");
    if (flag === 'no_size') where.push('c.size_id IS NULL');
    if (flag === 'awaiting') where.push(`c.source = 'erp' AND c.complete AND c.status = 'draft'`);
    if (flag === 'approved') where.push(`c.status = 'approved'`);
    const limit = Math.min(Math.max(+req.query.limit || 300, 1), 5000);
    const offset = Math.max(+req.query.offset || 0, 0);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, total] = await Promise.all([
      q(`SELECT ${COSTING_COLS}, b.batch_no, en.enquiry_no FROM costings c LEFT JOIN costing_batches b ON b.id = c.batch_id
         LEFT JOIN LATERAL (SELECT enquiry_no FROM enquiries WHERE costing_id = c.id ORDER BY id LIMIT 1) en ON true
         ${w} ORDER BY c.costed_on DESC NULLS LAST, c.id DESC LIMIT ${limit} OFFSET ${offset}`, args),
      one(`SELECT count(*)::int AS n FROM costings c ${w}`, args),
    ]);
    res.json({ rows, total: total.n });
  } catch (e) { next(e); }
});

// ── bulk costing ─────────────────────────────────────────────────────────────────────────────────
const MAX_BATCH_ROWS = 100;

r.get('/costing/batches', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT b.id, b.batch_no, b.title, b.customer_name, b.archived, b.created_by_name, b.updated_by_name,
             to_char(b.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS created_on,
             to_char(b.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS updated_at,
             count(c.id)::int AS rows, count(c.id) FILTER (WHERE c.complete)::int AS complete,
             COALESCE(sum(c.cost_value), 0)::float8 AS cost_value
        FROM costing_batches b LEFT JOIN costings c ON c.batch_id = b.id AND NOT c.archived
       GROUP BY b.id ORDER BY b.updated_at DESC LIMIT 300`));
  } catch (e) { next(e); }
});

async function batchById(id) {
  const b = await one(`SELECT id, batch_no, title, customer_id, customer_name, common, archived, created_by_name,
                              to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS created_at,
                              updated_by_name, to_char(updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS updated_at
                         FROM costing_batches WHERE id = $1`, [id]);
  if (!b) return null;
  b.rows = await q(`SELECT ${COSTING_COLS}, c.inputs, c.result, en.enquiry_id, en.enquiry_no FROM costings c
                     LEFT JOIN LATERAL (SELECT id AS enquiry_id, enquiry_no FROM enquiries WHERE costing_id = c.id ORDER BY id LIMIT 1) en ON true
                     WHERE c.batch_id = $1 AND NOT c.archived ORDER BY c.batch_pos NULLS LAST, c.id`, [id]);
  // Each row's board-rate marker, kept by its position in the batch (batch_pos, set on every save): none for an old row.
  const marks = Array.isArray(b.common?.board_from) ? b.common.board_from : [];
  for (const row of b.rows) row.board_from = row.batch_pos > 0 ? marks[row.batch_pos - 1] ?? null : null;
  return b;
}

// Where a bulk row's board rate came from (final review I4): the rule (or the ₹120 prefill), a common rate a person typed,
// a matched Product Master grade, or the row itself. The bulk screen carries a typed common rate only into rule and common
// rows; anything else is none — the row's own.
const BOARD_FROM = new Set(['rule', 'common', 'product', 'row']);

function batchFrom(body) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length) throw fail(400, 'Add at least one product to the batch.');
  if (rows.length > MAX_BATCH_ROWS) throw fail(400, `A batch holds up to ${MAX_BATCH_ROWS} products — split it into two.`);
  // The common settings, plus the extra quantities every row is also priced at (up to six).
  const quantities = [...new Set((Array.isArray(body?.common?.quantities) ? body.common.quantities : []).map(num).filter(x => x > 0))]
    .sort((a, b) => a - b).slice(0, 6);
  // board_typed: a person typed the common board rate (kept as a boolean, never inferred from the value). board_from: each
  // row's marker, by row position — the rows are saved in this order (batch_pos), so they come back in it.
  const common = { ...cleanInputs(body?.common), quantities, board_typed: body?.common?.board_typed === true,
    board_from: rows.map(row => (BOARD_FROM.has(row?.board_from) ? row.board_from : null)) };
  return {
    title: text(body?.title, 200),
    customer_id: intOrNull(body?.customer_id),
    customer_name: text(body?.customer_name, 160),
    common,
    rows: rows.map((row, i) => {
      const c = costingFrom({ customer_id: body?.customer_id, customer_name: body?.customer_name, ...row });
      if (!c.product_name) throw fail(400, `Row ${i + 1} has no product name.`);
      return { id: intOrNull(row?.id), enquiryId: intOrNull(row?.enquiry_id), c };
    }),
  };
}

r.post('/costing/batches', async (req, res, next) => {
  try {
    const b = batchFrom(req.body);
    const user = req.costingUser;
    const group = newGroup();
    let moved = 0;
    const id = await tx(async (qc, oc) => {
      const batchNo = await nextNumber('CI-CSB-', 'costing_batches', 'batch_no', oc);
      const row = await oc(`INSERT INTO costing_batches (batch_no, title, customer_id, customer_name, common, created_by, created_by_name, updated_by, updated_by_name)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7) RETURNING id`,
      [batchNo, b.title, b.customer_id, b.customer_name, b.common, user.id, user.name]);
      for (const [i, { c, enquiryId }] of b.rows.entries()) {
        const made = await insertCosting(c, { batchId: row.id, batchPos: i + 1, note: `Bulk costing ${batchNo}` }, qc, oc, user);
        if (await linkEnquiry(qc, enquiryId, made, row.id, user, group)) moved++;
      }
      await audit('costing_batch', row.id, 'create', `${batchNo} — ${b.rows.length} products`, qc, user.name);
      return row.id;
    });
    res.status(201).json({ ...(await batchById(id)), desk: moved ? { group, moved } : null });
  } catch (e) { next(e); }
});

// Saving an open batch is a POST, not a PUT: a new row mints a CI-CST- number, and minting routes are
// POSTs the client joins on a double-click (client/src/lib/writeOnce.js MINTING_POSTS).
r.post('/costing/batches/:id/save', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id);
    const b = batchFrom(req.body);
    const user = req.costingUser;
    const group = newGroup();
    let moved = 0;
    await tx(async (qc, oc) => {
      // The number lock first, before any row is locked (nextNumber's lock order): new rows mint
      // CI-CST- numbers further down.
      const fresh = b.rows.filter(x => !x.id).length;
      if (fresh) await lockDocNumber('CI-CST-', oc);
      const cur = await oc('SELECT id, batch_no FROM costing_batches WHERE id = $1 FOR UPDATE', [id || 0]);
      if (!cur) throw fail(404, 'No such batch.');
      const owned = new Set((await qc('SELECT id FROM costings WHERE batch_id = $1 AND NOT archived', [id])).map(x => x.id));
      for (const x of b.rows) if (x.id && !owned.has(x.id)) throw fail(409, 'A row in this batch was changed elsewhere — reopen the batch and try again.');
      await qc(`UPDATE costing_batches SET title = $2, customer_id = $3, customer_name = $4, common = $5,
                       updated_at = now(), updated_by = $6, updated_by_name = $7 WHERE id = $1`,
      [id, b.title, b.customer_id, b.customer_name, b.common, user.id, user.name]);
      const kept = new Set();
      for (const [i, x] of b.rows.entries()) {
        if (x.id) {
          kept.add(x.id);
          const done = await reviseCosting(x.id, x.c, { batchId: id, batchPos: i + 1, note: `Changed in bulk costing ${cur.batch_no}` }, qc, oc, user);
          if (await linkEnquiry(qc, x.enquiryId, done, id, user, group)) moved++;
        } else {
          const made = await insertCosting(x.c, { batchId: id, batchPos: i + 1, note: `Bulk costing ${cur.batch_no}` }, qc, oc, user);
          if (await linkEnquiry(qc, x.enquiryId, made, id, user, group)) moved++;
        }
      }
      // A row taken out of the batch is kept as a costing, hidden, not deleted — and its enquiry (Enquiry
      // desk) goes back to waiting in Costing, as the batch no longer costs it.
      for (const gone of owned) {
        if (kept.has(gone)) continue;
        await qc(`UPDATE costings SET archived = true, batch_pos = NULL, updated_at = now(), updated_by = $2, updated_by_name = $3 WHERE id = $1`,
          [gone, user.id, user.name]);
        moved += await unlinkCosting(qc, gone, user, group, `Taken out of bulk costing ${cur.batch_no}`);
      }
      await audit('costing_batch', id, 'update', `${cur.batch_no} — ${b.rows.length} products${fresh ? `, ${fresh} new` : ''}`, qc, user.name);
    });
    res.json({ ...(await batchById(id)), desk: moved ? { group, moved } : null });
  } catch (e) { next(e); }
});

r.get('/costing/batches/:id', async (req, res, next) => {
  try {
    const b = await batchById(intOrNull(req.params.id) || 0);
    if (!b) throw fail(404, 'No such batch.');
    res.json(b);
  } catch (e) { next(e); }
});

// Where a bulk costing's enquiries stand on the road to the customer's mail, with each stage's moment
// (client/src/lib/quoteProgress.js turns these into the progress bar). Times only — no price, no address.
r.get('/costing/batches/:id/progress', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id) || 0;
    const b = await one('SELECT id, batch_no, created_at FROM costing_batches WHERE id = $1', [id]);
    if (!b) throw fail(404, 'No such batch.');
    const rows = await q(`
      SELECT e.id, e.enquiry_no, e.status, e.finalised_at, qt.id AS quotation_id, c.approved_at,
             (SELECT max(ev.at) FROM enquiry_events ev WHERE ev.enquiry_id = e.id AND ev.action = 'price') AS priced_at,
             qt.quotation_no, qt.status AS q_status, qt.created_at AS q_created_at, qt.updated_at AS q_updated_at,
             qt.sent_at, qt.gmail_draft_url AS draft_url,
             j.queued_at, j.claimed_at, j.finished_at, j.status AS job_status, j.error AS job_error
        FROM enquiries e
        JOIN costings c ON c.id = e.costing_id
        LEFT JOIN quotations qt ON qt.id = e.quotation_id AND qt.status <> 'cancelled'
        LEFT JOIN enquiry_jobs j ON j.id = qt.job_id
       WHERE c.batch_id = $1 AND NOT c.archived AND e.status <> 'dropped'
       ORDER BY e.id`, [id]);
    res.json({ batch_id: b.id, batch_no: b.batch_no, batch_created_at: b.created_at, rows });
  } catch (e) { next(e); }
});

// ── Size Library ─────────────────────────────────────────────────────────────────────────────────
r.get('/costing/sizes', async (req, res, next) => {
  try {
    const all = req.query.all === '1';
    const rows = await q(`SELECT ${ENTRY_COLS}, s.source_refs, ${USAGE} FROM costing_sizes s
                           ${all ? '' : 'WHERE s.active'} ORDER BY s.size_key, s.style NULLS LAST, s.id`);
    const dies = await allDies();
    const dieKeys = new Map();
    for (const d of dies) {
      const k = parseSize(d.carton_size)?.key;
      if (k) dieKeys.set(k, [...(dieKeys.get(k) || []), d.code]);
    }
    for (const e of rows) e.dies = dieKeys.get(e.size_key) || [];
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/costing/sizes/duplicates', async (_req, res, next) => {
  try {
    const rows = await q(`SELECT ${ENTRY_COLS}, ${USAGE} FROM costing_sizes s WHERE s.active`);
    const entries = rows.map(e => ({ ...e, size: { key: e.size_key, kind: e.kind } }));
    const groups = possibleDuplicates(entries).map(g => ({
      kind: g.kind, size_key: g.size_key || null, size_keys: g.size_keys || null,
      entries: g.entries.map(({ size, ...e }) => e),
    }));
    res.json(groups);
  } catch (e) { next(e); }
});

r.post('/costing/sizes', async (req, res, next) => {
  try {
    const size = parseSize(req.body?.size_text);
    if (!size) throw fail(400, 'Type the size, e.g. 165 x 58 x 73.');
    const style = normStyle(req.body?.style);
    const sheetL = num(req.body?.sheet_l), sheetW = num(req.body?.sheet_w), ups = num(req.body?.ups);
    const u = req.costingUser;
    const row = await one(`
      INSERT INTO costing_sizes (size_key, kind, l_mm, w_mm, h_mm, style, sheet_l, sheet_w, ups, source, source_refs, notes, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', '[]', $10, $11, $11)
      ON CONFLICT DO NOTHING RETURNING id`,
    [size.key, size.kind, size.l, size.w, size.h, style, sheetL, sheetW, ups, text(req.body?.notes, 500), u.id]);
    if (!row) {
      const dup = await one(`SELECT id FROM costing_sizes WHERE size_key = $1 AND COALESCE(style, '') = COALESCE($2, '')
                               AND COALESCE(sheet_l, 0) = COALESCE($3, 0) AND COALESCE(sheet_w, 0) = COALESCE($4, 0) AND COALESCE(ups, 0) = COALESCE($5, 0)`,
      [size.key, style, sheetL, sheetW, ups]);
      throw fail(409, `This size, pasting and layout is already in the library (entry ${dup?.id ?? ''}).`.replace(' ()', ''));
    }
    await audit('costing_size', row.id, 'create', `${size.label}${style ? ` ${style}` : ''}`, q, u.name);
    res.status(201).json({ id: row.id, key: sizeEntryKey(size.key, style, sheetL, sheetW, ups) });
  } catch (e) { next(e); }
});

// Notes and retire / bring back only. A wrong layout is retired and the right one added, so earlier
// costings keep pointing at what they were costed on.
r.put('/costing/sizes/:id', async (req, res, next) => {
  try {
    const u = req.costingUser;
    const row = await one(`UPDATE costing_sizes SET notes = $2, active = $3, updated_at = now(), updated_by = $4
                            WHERE id = $1 RETURNING id, size_key, active`,
    [intOrNull(req.params.id) || 0, text(req.body?.notes, 500), req.body?.active !== false, u.id]);
    if (!row) throw fail(404, 'No such size.');
    await audit('costing_size', row.id, row.active ? 'update' : 'retire', row.size_key, q, u.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Rates (defaults) ─────────────────────────────────────────────────────────────────────────────
r.put('/costing/settings', async (req, res, next) => {
  try {
    const u = req.costingUser;
    if (!mayEditCostingRates(u)) throw fail(403, 'Only an admin can change the costing defaults.');
    const defaults = cleanInputs(req.body?.defaults);
    for (const k of ['qty', 'sheet_l', 'sheet_w', 'ups', 'gsm', 'target_price']) delete defaults[k];
    const coatings = (Array.isArray(req.body?.coatings) ? req.body.coatings : [])
      .map(c => ({ factor: num(c?.factor), name: text(c?.name, 60) || '' }))
      .filter(c => c.factor > 0)
      .slice(0, 20);
    const alert = num(req.body?.alert_pct);
    if (!(alert > 0 && alert <= 100)) throw fail(400, 'The difference alert must be between 1 and 100 %.');
    await q(`UPDATE costing_settings SET defaults = $1, coatings = $2, alert_pct = $3, customer_rates = COALESCE($5::jsonb, customer_rates), updated_at = now(), updated_by = $4 WHERE id = 1`,
      [defaults, JSON.stringify(coatings), alert, u.id, req.body?.customer_rates === undefined ? null : JSON.stringify(cleanCustomerRates(req.body.customer_rates))]);
    await audit('costing_settings', 1, 'update', 'Costing defaults changed', q, u.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
