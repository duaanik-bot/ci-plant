// The costing database helpers, shared (20 Nov 2026). They lived inside routes/costing.js; the enquiry desk's
// auto-costing (auto-costing.js) and its approve route need the same ones, and a route file cannot be imported
// by the module a route calls. So the saving, revising, approving and reading of costings, the size check's
// reads (library, Die Master, earlier costings, stocked sheets) and the reference figures live here, and the
// routes import them. This file imports NO route file — routes import the store, never the other way round.
// Behaviour is exactly what the costing routes always did. What a costing is made of (costingFrom, cleanInputs) and the
// Product Master row a costing starts from (PRODUCT_COLS, productById) live here too, so the auto-costing saves exactly
// what the costing form's save does.
import { q, one } from './db.js';
import { audit, nextNumber, optionalText } from './helpers.js';
import { PLANT_TODAY_SQL } from './plant-calendar.js';
import { computeCosting, parseSize, normStyle, num, CURRENT_FORMULA, INPUTS } from './costing-engine.js';
import { sizeRelation, matchDies, dieMasterMatches } from './costing-match.js';
import { registerMatches } from './die-list.js';
import { withRunWastage } from '../../client/src/lib/costingRules.js';

const fail = (status, error) => Object.assign(new Error(error), { status });
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);
const INPUT_KEYS = INPUTS.map(i => i.key);
const text = (v, max = 300) => optionalText(v)?.slice(0, max) ?? null;

// Only the form's inputs, as numbers (blank → null). History-only keys never come from a browser.
export function cleanInputs(raw = {}) {
  const out = {};
  for (const k of INPUT_KEYS) out[k] = num(raw?.[k]);
  return out;
}

// What a costing is made of, read from a request body. The figures are worked out here.
export function costingFrom(body) {
  const size = parseSize(body?.size_text);
  const inputs = withRunWastage(cleanInputs(body?.inputs));
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
    save_size: body?.save_size !== false,
  };
}

// What a costing takes from a Product Master entry.
export const PRODUCT_COLS = `
  p.id, p.name, p.code, p.size, p.gsm::float8 AS gsm, p.child_l::float8 AS sheet_l, p.child_w::float8 AS sheet_w,
  p.ups::float8 AS ups, p.coating, p.pasting_type, p.board_grade, p.colors::float8 AS colours, p.emboss, p.leafing,
  p.special, p.customer_id, cu.name AS customer_name`;

// One active Product Master entry in that shape, or null.
export async function productById(id) {
  if (!intOrNull(id)) return null;
  return one(`SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
               WHERE p.id = $1 AND p.active = 1`, [intOrNull(id)]);
}

// Columns a list or a comparison needs, numbers as numbers.
export const COSTING_COLS = `
  c.id, c.costing_no, c.source, c.source_row, c.batch_id, c.batch_pos, c.customer_id, c.customer_name,
  c.product_id, c.product_name, c.size_text, c.size_key, c.size_kind, c.style, c.size_id,
  to_char(c.costed_on, 'YYYY-MM-DD') AS costed_on, c.version, c.formula, c.complete, c.reproduced,
  c.qty::float8 AS qty, c.gsm::float8 AS gsm, c.cost_per_unit::float8 AS cost_per_unit,
  c.quote_per_unit::float8 AS quote_per_unit, c.cost_value::float8 AS cost_value,
  c.remarks, c.archived, jsonb_array_length(c.notes) AS note_count, c.status, c.auto_costed, c.approved_by_name,
  to_char(c.approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS approved_at, c.approved_version,
  c.created_by_name, c.created_at, c.updated_by_name, c.updated_at`;

// ── reference data ────────────────────────────────────────────────────────────────────────────────
export async function boardGrades() {
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
export async function typicalFigures() {
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

export const ENTRY_COLS = `
  s.id, s.size_key, s.kind, s.l_mm::float8 AS l_mm, s.w_mm::float8 AS w_mm, s.h_mm::float8 AS h_mm,
  s.style, s.sheet_l::float8 AS sheet_l, s.sheet_w::float8 AS sheet_w, s.ups::float8 AS ups,
  s.source, s.notes, s.active, (s.kld->>'rev')::int AS kld_rev`;
export const USAGE = `
  (SELECT count(*)::int FROM costings c WHERE c.size_id = s.id AND NOT c.archived) AS times_costed,
  (SELECT to_char(max(c.costed_on), 'YYYY-MM-DD') FROM costings c WHERE c.size_id = s.id AND NOT c.archived) AS last_costed`;

export async function libraryFor(size) {
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
export const allDies = () => q(`SELECT t.id, t.code, t.title, t.ups, t.sheet_size, t.carton_size, t.zone, t.location, t.condition,
                                p.name AS product_name
                           FROM tools t LEFT JOIN products p ON p.id = t.product_id
                          WHERE t.family = 'die' AND t.active = 1 ORDER BY t.code`);

export async function historyFor(sizeKey, excludeId) {
  if (!sizeKey) return [];
  return q(`SELECT ${COSTING_COLS}, c.inputs, c.result, c.sheet_result, c.notes
              FROM costings c
             WHERE c.size_key = $1 AND NOT c.archived AND c.complete AND c.id <> $2
             ORDER BY c.costed_on DESC NULLS LAST, c.id DESC LIMIT 40`, [sizeKey, excludeId || 0]);
}

// The library entry for a complete costing's size + pasting + layout — found, or made now, unless the
// user was asked and said no (save_size false): the costing is then saved without one.
export async function sizeEntryFor(c, qc, oc, user) {
  if (!c.size || !c.result.ok) return null;
  const { sheet_l, sheet_w, ups } = c.inputs;
  const found = await oc(`SELECT id FROM costing_sizes
                           WHERE size_key = $1 AND COALESCE(style, '') = COALESCE($2, '')
                             AND COALESCE(sheet_l, 0) = $3 AND COALESCE(sheet_w, 0) = $4 AND COALESCE(ups, 0) = $5`,
  [c.size.key, c.style, sheet_l, sheet_w, ups]);
  if (found) return found.id;
  if (!c.save_size) return null;
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
export const listValues = c => [
  c.inputs.qty, c.inputs.gsm,
  c.result.ok ? c.result.cost_per_unit : null, c.result.ok ? c.result.quote_per_unit : null,
  c.result.ok ? c.result.cost_value : null,
];
// jsonb hands keys back in its own order, so inputs are compared key by key, never as JSON text.

export const sameInputs = (a, b) => INPUT_KEYS.every(k => (num(a?.[k]) ?? null) === (num(b?.[k]) ?? null));
export async function insertCosting(c, { batchId = null, batchPos = null, note = null, auto = false }, qc, oc, user) {
  if (!c.product_name) throw fail(400, 'Give the product a name before saving.');
  const costingNo = (await nextNumber('CI-CST-', 'costings', 'costing_no', oc));
  const sizeId = await sizeEntryFor(c, qc, oc, user);
  const [qty, gsm, cpu, qpu, value] = listValues(c);
  const row = await oc(`
    INSERT INTO costings (costing_no, source, batch_id, batch_pos, customer_id, customer_name, product_id, product_name,
                          size_text, size_key, size_kind, l_mm, w_mm, h_mm, style, size_id, formula, inputs, result,
                          complete, qty, gsm, cost_per_unit, quote_per_unit, cost_value, remarks,
                          created_by, created_by_name, updated_by, updated_by_name, costed_on, auto_costed)
    VALUES ($1, 'erp', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26, $27, $26, $27, ${PLANT_TODAY_SQL}, $28)
    RETURNING id, costing_no`,
  [costingNo, batchId, batchPos, c.customer_id, c.customer_name, c.product_id, c.product_name,
    c.size_text, c.size?.key ?? null, c.size?.kind ?? null, c.size?.l ?? null, c.size?.w ?? null, c.size?.h ?? null,
    c.style, sizeId, CURRENT_FORMULA, c.inputs, c.result, c.result.ok, qty, gsm, cpu, qpu, value, c.remarks,
    user.id, user.name, auto]);
  await qc(`INSERT INTO costing_versions (costing_id, version, formula, inputs, result, note, created_by, created_by_name)
            VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
  [row.id, CURRENT_FORMULA, c.inputs, c.result, note || 'First costing', user.id, user.name]);
  await audit('costing', row.id, 'create', `${row.costing_no} — ${c.product_name}`, qc, user.name);
  return row;
}

// A revision: the header always takes the new values; the figures become a new version only when an
// input, the size or the pasting changed (a remark or a customer name is not a new price).
// A costing a person revises becomes theirs (20 Nov 2026): only the auto-costing's own revision (`auto`) keeps it Auto,
// and what CI Plant could not do by itself no longer stands on its enquiries (the costing, then its enquiries: the
// lock order the routes take).
export async function reviseCosting(id, c, { batchId, batchPos, note, auto = false } = {}, qc, oc, user) {
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
           updated_at = now(), updated_by = $28, updated_by_name = $29, auto_costed = $30
     WHERE id = $1`,
  [id, c.customer_id, c.customer_name, c.product_id, c.product_name, c.size_text, c.size?.key ?? null,
    c.size?.kind ?? null, c.size?.l ?? null, c.size?.w ?? null, c.size?.h ?? null, c.style, sizeId,
    CURRENT_FORMULA, c.inputs, c.result, c.result.ok, qty, gsm, cpu, qpu, value, c.remarks, version,
    batchId ?? null, batchPos ?? null, same, user.id, user.name, !!auto]);
  if (!auto) await qc('UPDATE enquiries SET auto_cost_why = NULL WHERE costing_id = $1 AND auto_cost_why IS NOT NULL', [id]);
  if (!same) {
    await qc(`INSERT INTO costing_versions (costing_id, version, formula, inputs, result, note, created_by, created_by_name)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, version, CURRENT_FORMULA, c.inputs, c.result, note || null, user.id, user.name]);
    await audit('costing', id, 'revise', `${cur.costing_no} — revision ${version}`, qc, user.name);
  }
  return { id, costing_no: cur.costing_no, version, revised: !same };
}

export async function costingById(id) {
  const c = await one(`SELECT ${COSTING_COLS}, c.inputs, c.result, c.sheet_result, c.notes, c.source_file,
                              b.batch_no, b.title AS batch_title
                         FROM costings c LEFT JOIN costing_batches b ON b.id = c.batch_id
                        WHERE c.id = $1`, [id]);
  if (!c) return null;
  // The enquiries this costing answers (Enquiry desk): saving it moves them on.
  c.enquiries = await q(`SELECT id, enquiry_no, status, customer_name, product_name FROM enquiries WHERE costing_id = $1 ORDER BY id`, [id]);
  c.versions = await q(`SELECT version, formula, inputs, result, note, created_by_name, approved_by_name,
                               to_char(approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS approved_at,
                               to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS created_at
                          FROM costing_versions WHERE costing_id = $1 ORDER BY version DESC`, [id]);
  return c;
}

// Approve a costing at its current revision. The stamp goes on the costing and on that revision, so a
// later revision (which sends the costing back to Draft) leaves the record of what was approved.
export async function approveCosting(id, user, qc, oc) {
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

// ── the size check ───────────────────────────────────────────────────────────────────────────────
// The board the plant stocks, one row per mill size and grain: active, not a leftover.
export const stockedSheets = () => q(`
  SELECT DISTINCT sheet_l::float8 AS sheet_l, sheet_w::float8 AS sheet_w, grain
    FROM materials
   WHERE category = 'board' AND active = 1 AND COALESCE(leftover, 0) = 0 AND sheet_l > 0 AND sheet_w > 0
   ORDER BY sheet_l, sheet_w, grain NULLS FIRST`);

// Everything the plant already knows of one size: Size Library entries, the Die Master and the die list, earlier
// costings, and the sheets in stock. The costing screen's size check and the enquiry desk's auto-costing both read it.
export async function sizeCheck(sizeText, { excludeId = null } = {}) {
  const size = parseSize(sizeText);
  const none = { exact: [], reordered: [], near: [] };
  if (!size) return { size: null, library: { exact: [], near: [] }, dies: none, register: none, history: [], sheets: await stockedSheets() };
  // the Die Master by the size proposals' rule (exact / another order / within 3 mm either way) and the die list beside
  // it (owner, 17 Nov 2026): an exact Die Master die turns New die off, a die-list die only offers to
  const carton = size.kind === 'carton';
  const [library, dies, history, register, sheets] = await Promise.all([
    libraryFor(size), allDies(), historyFor(size.key, intOrNull(excludeId)),
    carton ? registerMatches(size).catch(e => { console.error('[costing] die list check failed:', e.message); return none; }) : none,
    stockedSheets(),
  ]);
  return { size, library, dies: carton ? dieMasterMatches(size, dies) : { ...none, ...matchDies(size, dies) }, register, history, sheets };
}
