// Universal timeline — ONE feed for every module and every floor station.
// Reads the audit ledger (audit_log is already written by every route) for a
// custom date range, scoped to a module or a single production section, and
// enriches each event with a human label (JC number, PO number, product…).
import { Router } from 'express';
import { q } from '../db.js';
import { squash, squashSql } from '../search-key.js';

const r = Router();

// One free-text term against several columns, matched two ways and OR'd: the
// literal text as typed, plus the squashed key so "2038" finds a detail line
// reading '20 x 38'. The raw ILIKE stays so punctuation-dependent searches
// ('31.5', 'CI-BOX') keep working — squashing only widens. See search-key.js.
// `add` is the caller's positional-parameter binder.
function searchClause(search, cols, add) {
  const p = add(`%${search}%`);
  const clauses = cols.map(c => `${c} ILIKE ${p}`);
  const key = squash(search);
  if (key) {
    const k = add(`%${key}%`);
    for (const c of cols) clauses.push(`${squashSql(c)} LIKE ${k}`);
  }
  return `(${clauses.join(' OR ')})`;
}

// Which audit entities belong to which module scope. Keys line up with
// client/src/modules.js. Missing key (or 'all') = the entire plant.
// Overlap is deliberate — an order line's story belongs to Orders, Planning
// and Tracking alike.
const SCOPES = {
  track: ['order', 'order_line', 'job_card', 'job_stage', 'dispatch'],
  orders: ['order', 'order_line', 'gang_run'],
  invoices: ['invoice'],
  accounts: ['payment', 'invoice'],
  dispatch: ['dispatch', 'order_line'],
  planning: ['order_line', 'gang_run', 'requisition', 'product'],
  artwork: ['order_line'],
  production: ['job_card', 'job_stage', 'extra_sheet'],
  print_planning: ['job_card', 'gang_run', 'machine'],
  floor: ['job_stage', 'job_card', 'machine', 'extra_sheet'],
  extra_sheets: ['extra_sheet'],
  finished_goods: ['fg_lot'],
  tooling: ['tool', 'tools'],
  shade_cards: ['shade_card'],
  logbook: ['machine'],
  procurement: ['requisition', 'purchase_order', 'grn'],
  inventory: ['inventory', 'grn', 'materials'],
  masters: ['customers', 'vendors', 'materials', 'machines', 'employees',
    'dies', 'products', 'gst_rates', 'tools', 'tool', 'user', 'machine', 'product'],
};

// Per-entity label lookups, run in one batch per entity type after the main
// query. Each returns (id, label[, section]) for the ids that appeared.
// Exported so the Master-360 history drawer enriches its feeds the same way.
export const LOOKUPS = {
  order: `SELECT o.id, o.po_number || ' — ' || c.name AS label
          FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=ANY($1)`,
  order_line: `SELECT ol.id, p.name || ' · ' || o.po_number AS label
               FROM order_lines ol JOIN products p ON p.id=ol.product_id
               JOIN orders o ON o.id=ol.order_id WHERE ol.id=ANY($1)`,
  job_card: `SELECT jc.id, jc.jc_number || ' · ' || p.name AS label
             FROM job_cards jc JOIN products p ON p.id=jc.product_id WHERE jc.id=ANY($1)`,
  job_stage: `SELECT js.id, jc.jc_number || ' · ' || REPLACE(INITCAP(js.stage),'_',' ') AS label, js.stage AS section
              FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id WHERE js.id=ANY($1)`,
  requisition: `SELECT r.id, r.pr_number || ' — ' || m.name AS label
                FROM requisitions r JOIN materials m ON m.id=r.material_id WHERE r.id=ANY($1)`,
  purchase_order: `SELECT po.id, po.po_number || ' — ' || v.name AS label
                   FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=ANY($1)`,
  // A receipt has no material of its own any more — it names every board on it.
  // enrich() reads `label` (and `section`), so `label` is what this must yield;
  // `material_name` carries the same aggregate on its own for anything that
  // wants the boards without the document number in front of them.
  grn: `SELECT h.id, h.grn_number,
               STRING_AGG(DISTINCT m.name, ', ') AS material_name,
               h.grn_number || ' — ' || STRING_AGG(DISTINCT m.name, ', ') AS label
        FROM grn_headers h
        JOIN grn_lines gl ON gl.grn_header_id = h.id
        JOIN materials m ON m.id = gl.material_id
        WHERE h.id = ANY($1) GROUP BY h.id`,
  dispatch: `SELECT d.id, d.challan_number || ' — ' || c.name AS label
             FROM dispatches d JOIN customers c ON c.id=d.customer_id WHERE d.id=ANY($1)`,
  invoice: `SELECT i.id, i.invoice_number || ' — ' || c.name AS label
            FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=ANY($1)`,
  payment: `SELECT p.id, p.payment_number || ' — ' || c.name AS label
            FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.id=ANY($1)`,
  fg_lot: `SELECT l.id, l.lot_number || ' — ' || p.name AS label
           FROM fg_lots l JOIN products p ON p.id=l.product_id WHERE l.id=ANY($1)`,
  gang_run: `SELECT id, gang_number AS label FROM gang_runs WHERE id=ANY($1)`,
  extra_sheet: `SELECT x.id, x.xs_number || ' · ' || REPLACE(INITCAP(x.stage),'_',' ') AS label, x.stage AS section
                FROM extra_sheet_requests x WHERE x.id=ANY($1)`,
  machine: `SELECT id, name AS label FROM machines WHERE id=ANY($1)`,
  machines: `SELECT id, name AS label FROM machines WHERE id=ANY($1)`,
  product: `SELECT id, name AS label FROM products WHERE id=ANY($1)`,
  products: `SELECT id, name AS label FROM products WHERE id=ANY($1)`,
  inventory: `SELECT id, name AS label FROM materials WHERE id=ANY($1)`,
  materials: `SELECT id, name AS label FROM materials WHERE id=ANY($1)`,
  customers: `SELECT id, name AS label FROM customers WHERE id=ANY($1)`,
  vendors: `SELECT id, name AS label FROM vendors WHERE id=ANY($1)`,
  employees: `SELECT id, name AS label FROM employees WHERE id=ANY($1)`,
  dies: `SELECT id, die_number AS label FROM dies WHERE id=ANY($1)`,
  gst_rates: `SELECT id, label FROM gst_rates WHERE id=ANY($1)`,
  tools: `SELECT id, code || ' · ' || title AS label FROM tools WHERE id=ANY($1)`,
  tool: `SELECT id, code || ' · ' || title AS label FROM tools WHERE id=ANY($1)`,
  shade_card: `SELECT id, sc_number || ' · ' || title AS label FROM shade_cards WHERE id=ANY($1)`,
  user: `SELECT id, name AS label FROM users WHERE id=ANY($1)`,
};

// GET /timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=production&section=printing&q=&limit=&offset=
r.get('/timeline', async (req, res, next) => {
  try {
    const { from, to, scope = 'all', section = '', q: search = '' } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const where = [];
    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };

    // Date range on the plant clock (IST) regardless of where the DB runs.
    // Boundaries are converted to timestamps so the created_at index is used.
    if (from) where.push(`a.created_at >= (${add(from)}::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    if (to) where.push(`a.created_at < ((${add(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);

    const entities = SCOPES[scope];
    if (entities) where.push(`a.entity = ANY(${add(entities)})`);

    // Station drill-down — stage events at that section, plus its machines
    // and the extra-sheet requests raised from it.
    if (section) {
      const s = add(section);
      where.push(`(
        (a.entity='job_stage' AND EXISTS (SELECT 1 FROM job_stages js WHERE js.id=a.entity_id AND js.stage=${s}))
        OR (a.entity='machine' AND EXISTS (SELECT 1 FROM machines mc WHERE mc.id=a.entity_id AND mc.type=${s}))
        OR (a.entity='extra_sheet' AND EXISTS (SELECT 1 FROM extra_sheet_requests xs WHERE xs.id=a.entity_id AND xs.stage=${s}))
      )`);
    }

    if (search) where.push(searchClause(search, ['a.action', 'a.detail', 'a.user_name'], add));

    // The Tooling Hub keeps its own append-only log (tool_events) instead of
    // audit_log — fold it into the same feed for plant-wide and tooling views.
    // Station drill-downs skip it: tools don't belong to a section.
    const includeTools = !section && (!entities || scope === 'tooling');
    let toolSql = '';
    if (includeTools) {
      const tw = [];
      if (from) tw.push(`e.at >= (${add(from)}::timestamp AT TIME ZONE 'Asia/Kolkata')`);
      if (to) tw.push(`e.at < ((${add(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
      if (search) tw.push(searchClause(search, ['e.action', 'e.note', 'e.user_name'], add));
      toolSql = `
      UNION ALL
      SELECT 't' || e.id AS id, 'tool' AS entity, e.tool_id AS entity_id,
             CASE WHEN e.action IN ('moved','undo')
                  THEN e.action || ':' || COALESCE(e.from_zone,'?') || '→' || COALESCE(e.to_zone,'?')
                  ELSE e.action END AS action,
             e.note AS detail, e.user_name, e.at AS ts
      FROM tool_events e
      ${tw.length ? 'WHERE ' + tw.join(' AND ') : ''}`;
    }

    const rows = await q(`
      SELECT * FROM (
        SELECT 'a' || a.id AS id, a.entity, a.entity_id, a.action, a.detail, a.user_name, a.created_at AS ts
        FROM audit_log a
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ${toolSql}
      ) u
      ORDER BY u.ts DESC, u.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}`, params);

    const has_more = rows.length > limit;
    const events = rows.slice(0, limit);

    // Enrich with display labels, one query per entity type that appeared.
    const byEntity = {};
    for (const e of events) {
      if (e.entity_id != null && LOOKUPS[e.entity]) (byEntity[e.entity] ??= new Set()).add(e.entity_id);
    }
    const labels = {};
    await Promise.all(Object.entries(byEntity).map(async ([entity, ids]) => {
      const found = await q(LOOKUPS[entity], [[...ids]]);
      labels[entity] = Object.fromEntries(found.map(f => [f.id, f]));
    }));
    for (const e of events) {
      const hit = labels[e.entity]?.[e.entity_id];
      e.label = hit?.label ?? null;
      e.section = hit?.section ?? null;
    }

    res.json({ events, has_more });
  } catch (e) { next(e); }
});

export default r;
