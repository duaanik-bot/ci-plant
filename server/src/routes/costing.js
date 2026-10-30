// Costing — new-product costing, worked out by server/src/costing-engine.js (the plant's cost sheet),
// saved with every revision, checked against the Size Library and the Die Master, and compared with
// earlier costings of the same size.
//
//   GET  /costing/bootstrap              defaults, coating factors, board grades with today's ₹/kg
//   GET  /costing/size-check?size=&exclude=   library entries, dies and earlier costings for one size
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
//
// The figures are ALWAYS worked out here on save — whatever the browser showed is not trusted.
// Audit lines carry the costing number and what happened, never a price: the audit log is read by
// every login (Timeline).
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, lockDocNumber, optionalText } from '../helpers.js';
import { PLANT_TODAY_SQL } from '../plant-calendar.js';
import { computeCosting, parseSize, normStyle, num, CURRENT_FORMULA, FORMULAS, INPUTS, STYLES } from '../costing-engine.js';
import { possibleDuplicates, sizeEntryKey } from '../costing-sheet.js';
import { matchDies, sizeRelation, mayCost, mayEditCostingRates, mayApproveCosting } from '../costing-match.js';

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

const INPUT_KEYS = INPUTS.map(i => i.key);
// Only the form's inputs, as numbers (blank → null). History-only keys never come from a browser.
export function cleanInputs(raw = {}) {
  const out = {};
  for (const k of INPUT_KEYS) out[k] = num(raw?.[k]);
  return out;
}
const text = (v, max = 300) => optionalText(v)?.slice(0, max) ?? null;
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);

// Columns a list or a comparison needs, numbers as numbers.
const COSTING_COLS = `
  c.id, c.costing_no, c.source, c.source_row, c.batch_id, c.batch_pos, c.customer_id, c.customer_name,
  c.product_id, c.product_name, c.size_text, c.size_key, c.size_kind, c.style, c.size_id,
  to_char(c.costed_on, 'YYYY-MM-DD') AS costed_on, c.version, c.formula, c.complete, c.reproduced,
  c.qty::float8 AS qty, c.gsm::float8 AS gsm, c.cost_per_unit::float8 AS cost_per_unit,
  c.quote_per_unit::float8 AS quote_per_unit, c.cost_value::float8 AS cost_value,
  c.remarks, c.archived, jsonb_array_length(c.notes) AS note_count, c.status, c.approved_by_name,
  to_char(c.approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS approved_at, c.approved_version,
  c.created_by_name, c.created_at, c.updated_by_name, c.updated_at`;

// ── reference data ────────────────────────────────────────────────────────────────────────────────
async function boardGrades() {
  // Today's ₹/kg per grade, the plant-wide rate (no vendor), as Masters → Board Rates sets it.
  return q(`
    SELECT DISTINCT ON (grade) grade, rate_per_kg::float8 AS rate_per_kg,
           to_char(effective_from, 'YYYY-MM-DD') AS effective_from
      FROM board_rates
     WHERE vendor_id IS NULL AND active = 1 AND rate_per_kg > 0
       AND (effective_from IS NULL OR effective_from <= ${PLANT_TODAY_SQL})
     ORDER BY grade, effective_from DESC NULLS LAST, id DESC`);
}

// What the plant's own costings usually carry, worked out live from the last two years so the
// recommendations move with practice: die & pasting by pasting style, embossing when used, and the
// process charge per colour (the history says ~₹500 a colour).
async function typicalFigures() {
  const since = `(${PLANT_TODAY_SQL} - interval '2 years')`;
  const [dp, emb, proc] = await Promise.all([
    q(`SELECT style, percentile_cont(0.5) WITHIN GROUP (ORDER BY (inputs->>'dp_rate')::numeric)::float8 AS value, count(*)::int AS n
         FROM costings WHERE complete AND NOT archived AND style IS NOT NULL AND costed_on >= ${since}
          AND (inputs->>'dp_rate')::numeric > 0 GROUP BY style HAVING count(*) >= 5`),
    one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (inputs->>'emb_rate')::numeric)::float8 AS value, count(*)::int AS n
           FROM costings WHERE complete AND NOT archived AND costed_on >= ${since} AND (inputs->>'emb_rate')::numeric > 0`),
    one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (inputs->>'process')::numeric / (inputs->>'colours')::numeric)::float8 AS value, count(*)::int AS n
           FROM costings WHERE complete AND NOT archived AND costed_on >= ${since}
            AND (inputs->>'colours')::numeric > 0 AND (inputs->>'process')::numeric > 0`),
  ]);
  return {
    dp_by_style: Object.fromEntries(dp.map(r => [r.style, { value: r.value, n: r.n }])),
    emb: emb?.n >= 5 ? { value: emb.value, n: emb.n } : null,
    process_per_colour: proc?.n >= 5 ? { value: proc.value, n: proc.n } : null,
  };
}

r.get('/costing/bootstrap', async (req, res, next) => {
  try {
    const settings = await one('SELECT defaults, coatings, alert_pct::float8 AS alert_pct FROM costing_settings WHERE id = 1');
    res.json({
      settings: settings || { defaults: {}, coatings: [], alert_pct: 15 },
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
const ENTRY_COLS = `
  s.id, s.size_key, s.kind, s.l_mm::float8 AS l_mm, s.w_mm::float8 AS w_mm, s.h_mm::float8 AS h_mm,
  s.style, s.sheet_l::float8 AS sheet_l, s.sheet_w::float8 AS sheet_w, s.ups::float8 AS ups,
  s.source, s.notes, s.active`;
const USAGE = `
  (SELECT count(*)::int FROM costings c WHERE c.size_id = s.id AND NOT c.archived) AS times_costed,
  (SELECT to_char(max(c.costed_on), 'YYYY-MM-DD') FROM costings c WHERE c.size_id = s.id AND NOT c.archived) AS last_costed`;

async function libraryFor(size) {
  if (!size) return { exact: [], near: [] };
  const exact = await q(`SELECT ${ENTRY_COLS}, ${USAGE} FROM costing_sizes s
                          WHERE s.size_key = $1 AND s.active ORDER BY times_costed DESC, s.id`, [size.key]);
  if (size.kind === 'other') return { exact, near: [] };
  // Near: a small window around each side, or any order of the same numbers; sizeRelation decides.
  const dims = [size.l, size.w, size.h].filter(x => x != null);
  const lo = Math.min(...dims) - 2, hi = Math.max(...dims) + 2;
  const pool = await q(`SELECT ${ENTRY_COLS}, ${USAGE} FROM costing_sizes s
                         WHERE s.active AND s.kind = $1 AND s.size_key <> $2
                           AND s.l_mm BETWEEN $3 AND $4 AND s.w_mm BETWEEN $3 AND $4
                           AND (s.h_mm IS NULL OR s.h_mm BETWEEN $3 AND $4)`, [size.kind, size.key, lo, hi]);
  const near = pool.filter(e => sizeRelation(size, { kind: e.kind, key: e.size_key, l: e.l_mm, w: e.w_mm, h: e.h_mm }) === 'near')
    .sort((a, b) => b.times_costed - a.times_costed);
  return { exact, near };
}

// The Die Master is the Tooling Hub's die family (tools), not the legacy dies table it was copied from.
const allDies = () => q(`SELECT t.id, t.code, t.title, t.ups, t.sheet_size, t.carton_size, t.zone, t.location, t.condition,
                                p.name AS product_name
                           FROM tools t LEFT JOIN products p ON p.id = t.product_id
                          WHERE t.family = 'die' AND t.active = 1 ORDER BY t.code`);

async function historyFor(sizeKey, excludeId) {
  if (!sizeKey) return [];
  return q(`SELECT ${COSTING_COLS}, c.inputs, c.result, c.sheet_result, c.notes
              FROM costings c
             WHERE c.size_key = $1 AND NOT c.archived AND c.complete AND c.id <> $2
             ORDER BY c.costed_on DESC NULLS LAST, c.id DESC LIMIT 40`, [sizeKey, excludeId || 0]);
}

r.get('/costing/size-check', async (req, res, next) => {
  try {
    const size = parseSize(req.query.size);
    if (!size) return res.json({ size: null, library: { exact: [], near: [] }, dies: { exact: [], near: [] }, history: [] });
    const [library, dies, history] = await Promise.all([
      libraryFor(size), allDies(), historyFor(size.key, intOrNull(req.query.exclude)),
    ]);
    res.json({ size, library, dies: matchDies(size, dies), history });
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

// What a costing takes from a Product Master entry.
const PRODUCT_COLS = `
  p.id, p.name, p.code, p.size, p.gsm::float8 AS gsm, p.child_l::float8 AS sheet_l, p.child_w::float8 AS sheet_w,
  p.ups::float8 AS ups, p.coating, p.pasting_type, p.board_grade, p.colors::float8 AS colours, p.emboss, p.leafing,
  p.special, p.customer_id, cu.name AS customer_name`;

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
// What a costing is made of, read from a request body. The figures are worked out here.
function costingFrom(body) {
  const size = parseSize(body?.size_text);
  const inputs = cleanInputs(body?.inputs);
  const result = computeCosting(inputs, CURRENT_FORMULA);
  return {
    customer_id: intOrNull(body?.customer_id),
    customer_name: text(body?.customer_name, 160),
    product_id: intOrNull(body?.product_id),
    product_name: text(body?.product_name, 200),
    size_text: text(body?.size_text, 60),
    size,
    style: normStyle(body?.style),
    remarks: text(body?.remarks, 1000),
    inputs,
    result,
  };
}

// The library entry for a complete costing's size + pasting + layout — found, or made now. Every
// size the plant costs ends up in the library this way.
async function sizeEntryFor(c, qc, oc, user) {
  if (!c.size || !c.result.ok) return null;
  const { sheet_l, sheet_w, ups } = c.inputs;
  const found = await oc(`SELECT id FROM costing_sizes
                           WHERE size_key = $1 AND COALESCE(style, '') = COALESCE($2, '')
                             AND COALESCE(sheet_l, 0) = $3 AND COALESCE(sheet_w, 0) = $4 AND COALESCE(ups, 0) = $5`,
  [c.size.key, c.style, sheet_l, sheet_w, ups]);
  if (found) return found.id;
  const made = await oc(`
    INSERT INTO costing_sizes (size_key, kind, l_mm, w_mm, h_mm, style, sheet_l, sheet_w, ups, source, source_refs, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'costing', '[]', $10, $10)
    ON CONFLICT DO NOTHING RETURNING id`,
  [c.size.key, c.size.kind, c.size.l, c.size.w, c.size.h, c.style, sheet_l, sheet_w, ups, user.id]);
  if (made) return made.id;
  return (await oc(`SELECT id FROM costing_sizes WHERE size_key = $1 AND COALESCE(style, '') = COALESCE($2, '')
                      AND COALESCE(sheet_l, 0) = $3 AND COALESCE(sheet_w, 0) = $4 AND COALESCE(ups, 0) = $5`,
  [c.size.key, c.style, sheet_l, sheet_w, ups]))?.id ?? null;
}

// The figures a list shows, copied out of inputs and result (blank while the costing is incomplete).
const listValues = c => [
  c.inputs.qty, c.inputs.gsm,
  c.result.ok ? c.result.cost_per_unit : null, c.result.ok ? c.result.quote_per_unit : null,
  c.result.ok ? c.result.cost_value : null,
];
// jsonb hands keys back in its own order, so inputs are compared key by key, never as JSON text.
export const sameInputs = (a, b) => INPUT_KEYS.every(k => (num(a?.[k]) ?? null) === (num(b?.[k]) ?? null));

async function insertCosting(c, { batchId = null, batchPos = null, note = null }, qc, oc, user) {
  if (!c.product_name) throw fail(400, 'Give the product a name before saving.');
  const costingNo = (await nextNumber('CI-CST-', 'costings', 'costing_no', oc));
  const sizeId = await sizeEntryFor(c, qc, oc, user);
  const [qty, gsm, cpu, qpu, value] = listValues(c);
  const row = await oc(`
    INSERT INTO costings (costing_no, source, batch_id, batch_pos, customer_id, customer_name, product_id, product_name,
                          size_text, size_key, size_kind, l_mm, w_mm, h_mm, style, size_id, formula, inputs, result,
                          complete, qty, gsm, cost_per_unit, quote_per_unit, cost_value, remarks,
                          created_by, created_by_name, updated_by, updated_by_name, costed_on)
    VALUES ($1, 'erp', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26, $27, $26, $27, ${PLANT_TODAY_SQL})
    RETURNING id, costing_no`,
  [costingNo, batchId, batchPos, c.customer_id, c.customer_name, c.product_id, c.product_name,
    c.size_text, c.size?.key ?? null, c.size?.kind ?? null, c.size?.l ?? null, c.size?.w ?? null, c.size?.h ?? null,
    c.style, sizeId, CURRENT_FORMULA, c.inputs, c.result, c.result.ok, qty, gsm, cpu, qpu, value, c.remarks,
    user.id, user.name]);
  await qc(`INSERT INTO costing_versions (costing_id, version, formula, inputs, result, note, created_by, created_by_name)
            VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
  [row.id, CURRENT_FORMULA, c.inputs, c.result, note || 'First costing', user.id, user.name]);
  await audit('costing', row.id, 'create', `${row.costing_no} — ${c.product_name}`, qc, user.name);
  return row;
}

// A revision: the header always takes the new values; the figures become a new version only when an
// input, the size or the pasting changed (a remark or a customer name is not a new price).
async function reviseCosting(id, c, { batchId, batchPos, note } = {}, qc, oc, user) {
  const cur = await oc('SELECT id, costing_no, source, version, formula, inputs, size_key, style FROM costings WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw fail(404, 'No such costing.');
  if (cur.source !== 'erp') throw fail(409, 'Costings from the old cost sheet are kept as the sheet had them. Use “Cost again” to start a new costing from it.');
  if (!c.product_name) throw fail(400, 'Give the product a name before saving.');
  const same = sameInputs(cur.inputs, c.inputs)
    && (cur.size_key || null) === (c.size?.key ?? null) && (cur.style || null) === (c.style || null)
    && cur.formula === CURRENT_FORMULA;
  const version = same ? cur.version : cur.version + 1;
  const sizeId = await sizeEntryFor(c, qc, oc, user);
  const [qty, gsm, cpu, qpu, value] = listValues(c);
  await qc(`
    UPDATE costings SET customer_id = $2, customer_name = $3, product_id = $4, product_name = $5, size_text = $6,
           size_key = $7, size_kind = $8, l_mm = $9, w_mm = $10, h_mm = $11, style = $12, size_id = $13,
           formula = $14, inputs = $15, result = $16, complete = $17, qty = $18, gsm = $19, cost_per_unit = $20,
           quote_per_unit = $21, cost_value = $22, remarks = $23, version = $24,
           batch_id = COALESCE($25::int, batch_id), batch_pos = COALESCE($26::int, batch_pos),
           costed_on = CASE WHEN $27::boolean THEN costed_on ELSE ${PLANT_TODAY_SQL} END,
           status = CASE WHEN $27::boolean THEN status ELSE 'draft' END,
           approved_by = CASE WHEN $27::boolean THEN approved_by END,
           approved_by_name = CASE WHEN $27::boolean THEN approved_by_name END,
           approved_at = CASE WHEN $27::boolean THEN approved_at END,
           approved_version = CASE WHEN $27::boolean THEN approved_version END,
           updated_at = now(), updated_by = $28, updated_by_name = $29
     WHERE id = $1`,
  [id, c.customer_id, c.customer_name, c.product_id, c.product_name, c.size_text, c.size?.key ?? null,
    c.size?.kind ?? null, c.size?.l ?? null, c.size?.w ?? null, c.size?.h ?? null, c.style, sizeId,
    CURRENT_FORMULA, c.inputs, c.result, c.result.ok, qty, gsm, cpu, qpu, value, c.remarks, version,
    batchId ?? null, batchPos ?? null, same, user.id, user.name]);
  if (!same) {
    await qc(`INSERT INTO costing_versions (costing_id, version, formula, inputs, result, note, created_by, created_by_name)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, version, CURRENT_FORMULA, c.inputs, c.result, note || null, user.id, user.name]);
    await audit('costing', id, 'revise', `${cur.costing_no} — revision ${version}`, qc, user.name);
  }
  return { id, costing_no: cur.costing_no, version, revised: !same };
}

async function costingById(id) {
  const c = await one(`SELECT ${COSTING_COLS}, c.inputs, c.result, c.sheet_result, c.notes, c.source_file,
                              b.batch_no, b.title AS batch_title
                         FROM costings c LEFT JOIN costing_batches b ON b.id = c.batch_id
                        WHERE c.id = $1`, [id]);
  if (!c) return null;
  c.versions = await q(`SELECT version, formula, inputs, result, note, created_by_name, approved_by_name,
                               to_char(approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS approved_at,
                               to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS created_at
                          FROM costing_versions WHERE costing_id = $1 ORDER BY version DESC`, [id]);
  return c;
}

r.post('/costing/costings', async (req, res, next) => {
  try {
    const c = costingFrom(req.body);
    const row = await tx((qc, oc) => insertCosting(c, { note: text(req.body?.note, 300) }, qc, oc, req.costingUser));
    res.status(201).json(await costingById(row.id));
  } catch (e) { next(e); }
});

r.put('/costing/costings/:id', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id);
    if (!id) throw fail(404, 'No such costing.');
    const c = costingFrom(req.body);
    await tx((qc, oc) => reviseCosting(id, c, { note: text(req.body?.note, 300) }, qc, oc, req.costingUser));
    res.json(await costingById(id));
  } catch (e) { next(e); }
});

r.get('/costing/costings/:id', async (req, res, next) => {
  try {
    const c = await costingById(intOrNull(req.params.id) || 0);
    if (!c) throw fail(404, 'No such costing.');
    res.json(c);
  } catch (e) { next(e); }
});

// Approve a costing at its current revision. The stamp goes on the costing and on that revision, so a
// later revision (which sends the costing back to Draft) leaves the record of what was approved.
async function approveCosting(id, user, qc, oc) {
  const c = await oc(`SELECT id, costing_no, source, complete, archived, status, version FROM costings WHERE id = $1 FOR UPDATE`, [id]);
  if (!c) throw fail(404, 'No such costing.');
  if (c.source !== 'erp') throw fail(409, 'Old cost-sheet records are not approved — cost it again to make a costing that can be.');
  if (!c.complete) throw fail(409, `${c.costing_no} is not complete — fill it in before it is approved.`);
  if (c.archived) throw fail(409, `${c.costing_no} is hidden — show it again before approving it.`);
  if (c.status === 'approved') return { id, costing_no: c.costing_no, already: true };
  await qc(`UPDATE costings SET status = 'approved', approved_by = $2, approved_by_name = $3, approved_at = now(), approved_version = version
             WHERE id = $1`, [id, user.id, user.name]);
  await qc(`UPDATE costing_versions SET approved_by_name = $3, approved_at = now() WHERE costing_id = $1 AND version = $2`,
    [id, c.version, user.name]);
  await audit('costing', id, 'approve', `${c.costing_no} — revision ${c.version}`, qc, user.name);
  return { id, costing_no: c.costing_no, already: false };
}

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
      q(`SELECT ${COSTING_COLS}, b.batch_no FROM costings c LEFT JOIN costing_batches b ON b.id = c.batch_id
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
  b.rows = await q(`SELECT ${COSTING_COLS}, c.inputs, c.result FROM costings c
                     WHERE c.batch_id = $1 AND NOT c.archived ORDER BY c.batch_pos NULLS LAST, c.id`, [id]);
  return b;
}

function batchFrom(body) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length) throw fail(400, 'Add at least one product to the batch.');
  if (rows.length > MAX_BATCH_ROWS) throw fail(400, `A batch holds up to ${MAX_BATCH_ROWS} products — split it into two.`);
  // The common settings, plus the extra quantities every row is also priced at (up to six).
  const quantities = [...new Set((Array.isArray(body?.common?.quantities) ? body.common.quantities : []).map(num).filter(x => x > 0))]
    .sort((a, b) => a - b).slice(0, 6);
  const common = { ...cleanInputs(body?.common), quantities };
  return {
    title: text(body?.title, 200),
    customer_id: intOrNull(body?.customer_id),
    customer_name: text(body?.customer_name, 160),
    common,
    rows: rows.map((row, i) => {
      const c = costingFrom({ customer_id: body?.customer_id, customer_name: body?.customer_name, ...row });
      if (!c.product_name) throw fail(400, `Row ${i + 1} has no product name.`);
      return { id: intOrNull(row?.id), c };
    }),
  };
}

r.post('/costing/batches', async (req, res, next) => {
  try {
    const b = batchFrom(req.body);
    const user = req.costingUser;
    const id = await tx(async (qc, oc) => {
      const batchNo = await nextNumber('CI-CSB-', 'costing_batches', 'batch_no', oc);
      const row = await oc(`INSERT INTO costing_batches (batch_no, title, customer_id, customer_name, common, created_by, created_by_name, updated_by, updated_by_name)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7) RETURNING id`,
      [batchNo, b.title, b.customer_id, b.customer_name, b.common, user.id, user.name]);
      for (const [i, { c }] of b.rows.entries()) {
        await insertCosting(c, { batchId: row.id, batchPos: i + 1, note: `Bulk costing ${batchNo}` }, qc, oc, user);
      }
      await audit('costing_batch', row.id, 'create', `${batchNo} — ${b.rows.length} products`, qc, user.name);
      return row.id;
    });
    res.status(201).json(await batchById(id));
  } catch (e) { next(e); }
});

// Saving an open batch is a POST, not a PUT: a new row mints a CI-CST- number, and minting routes are
// POSTs the client joins on a double-click (client/src/lib/writeOnce.js MINTING_POSTS).
r.post('/costing/batches/:id/save', async (req, res, next) => {
  try {
    const id = intOrNull(req.params.id);
    const b = batchFrom(req.body);
    const user = req.costingUser;
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
          await reviseCosting(x.id, x.c, { batchId: id, batchPos: i + 1, note: `Changed in bulk costing ${cur.batch_no}` }, qc, oc, user);
        } else {
          await insertCosting(x.c, { batchId: id, batchPos: i + 1, note: `Bulk costing ${cur.batch_no}` }, qc, oc, user);
        }
      }
      // A row taken out of the batch is kept as a costing, hidden, not deleted.
      for (const gone of owned) {
        if (kept.has(gone)) continue;
        await qc(`UPDATE costings SET archived = true, batch_pos = NULL, updated_at = now(), updated_by = $2, updated_by_name = $3 WHERE id = $1`,
          [gone, user.id, user.name]);
      }
      await audit('costing_batch', id, 'update', `${cur.batch_no} — ${b.rows.length} products${fresh ? `, ${fresh} new` : ''}`, qc, user.name);
    });
    res.json(await batchById(id));
  } catch (e) { next(e); }
});

r.get('/costing/batches/:id', async (req, res, next) => {
  try {
    const b = await batchById(intOrNull(req.params.id) || 0);
    if (!b) throw fail(404, 'No such batch.');
    res.json(b);
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
    await q(`UPDATE costing_settings SET defaults = $1, coatings = $2, alert_pct = $3, updated_at = now(), updated_by = $4 WHERE id = 1`,
      [defaults, JSON.stringify(coatings), alert, u.id]);
    await audit('costing_settings', 1, 'update', 'Costing defaults changed', q, u.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
