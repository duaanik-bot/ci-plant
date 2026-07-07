// ─── Tooling Hub API ─────────────────────────────────────────────────────────
// One board call (tools + needed-for-jobs rail), CRUD, zone moves with an
// append-only event log, undo, and the auto-flip: a tool arriving in the rack
// re-checks waiting order lines and promotes planned → ready (same pattern as
// the artwork endpoint).
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { readiness, setLineStatus } from '../helpers.js';
import { requireRole } from '../auth.js';
import { TOOL_FAMILIES, TOOL_ZONES, toolingDetail, toolingGateOk } from '../tooling-gate.js';

const r = Router();
const canManage = requireRole('planner');
const canMove = requireRole('planner', 'production');

const EDIT_COLS = ['title', 'product_id', 'maker', 'condition', 'location', 'notes',
  'ups', 'sheet_size', 'carton_size', 'colors', 'emboss_type', 'shade_ref', 'active'];

const TOOL_VIEW = `
  SELECT t.*, p.name AS product_name, p.code AS product_code, c.name AS customer_name,
         EXTRACT(EPOCH FROM (now() - t.zone_since))::bigint AS zone_seconds,
         le.action AS last_action, le.user_name AS last_user, le.at AS last_at
  FROM tools t
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN LATERAL (SELECT action, user_name, at FROM tool_events
                     WHERE tool_id = t.id ORDER BY id DESC LIMIT 1) le ON true`;

// Per-family sequential codes (DIE-0001 …). Migrated dies keep their real
// numbers, so we scan only rows that match our own prefix.
async function nextToolCode(family, oc = one) {
  const prefix = TOOL_FAMILIES[family].prefix;
  const row = await oc(
    `SELECT code FROM tools WHERE family=$1 AND code LIKE $2 ORDER BY id DESC LIMIT 1`,
    [family, `${prefix}%`]);
  const m = row?.code?.match(/(\d+)$/);
  return `${prefix}${String(m ? +m[1] + 1 : 1).padStart(4, '0')}`;
}

// A tool reached the rack: promote every planned, artwork-locked line of the
// linked product whose full gate now passes. Returns how many flipped.
async function autoFlip(tool, qc, oc, user) {
  const lines = await qc(`
    SELECT ol.* FROM order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.status = 'planned' AND ol.artwork_locked = 1
      AND (p.id = $1 OR p.tool_id = $2)`,
    [tool.product_id ?? -1, tool.id]);
  let flipped = 0;
  for (const line of lines) {
    const gate = await readiness(line, oc);
    if (gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
      await setLineStatus(line.id, 'ready', qc, oc, user);
      flipped++;
    }
  }
  return flipped;
}

// ── Board: tools + needed-for-jobs, one call ────────────────────────────────
r.get('/tooling/board', async (_req, res, next) => {
  try {
    const tools = await q(`${TOOL_VIEW} WHERE t.active = 1 ORDER BY t.zone_since DESC`);

    const lines = await q(`
      SELECT ol.id, ol.product_id, ol.tooling_ok, ol.spec_override,
             o.po_number, o.delivery_date, c.name AS customer_name,
             p.name AS product_name, p.code AS product_code, p.special, p.tool_id
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      WHERE ol.status IN ('planned','ready') AND ol.artwork_locked = 1
      ORDER BY o.delivery_date NULLS LAST, ol.id`);

    const every = await q('SELECT * FROM tools');
    const needed = [];
    for (const l of lines) {
      const ov = typeof l.spec_override === 'string' ? JSON.parse(l.spec_override) : l.spec_override;
      const product = { id: l.product_id, special: ov?.special ?? l.special, tool_id: l.tool_id };
      const mine = every.filter(t => t.product_id === l.product_id || t.id === l.tool_id);
      const detail = toolingDetail(product, mine);
      if (toolingGateOk(detail, l.tooling_ok)) continue;
      needed.push({
        line_id: l.id, po_number: l.po_number, customer_name: l.customer_name,
        product_id: l.product_id, product_name: l.product_name,
        product_code: l.product_code, delivery_date: l.delivery_date,
        gaps: detail.filter(d => (d.hard ? d.status !== 'ready' : d.status === 'not_ready')),
      });
    }
    res.json({ tools, needed });
  } catch (e) { next(e); }
});

// ── Flat list (ledger, pickers) ─────────────────────────────────────────────
r.get('/tools', async (req, res, next) => {
  try {
    const wh = ['t.active = 1'];
    const params = [];
    if (req.query.family) { params.push(req.query.family); wh.push(`t.family = $${params.length}`); }
    if (req.query.product_id) { params.push(+req.query.product_id); wh.push(`t.product_id = $${params.length}`); }
    res.json(await q(`${TOOL_VIEW} WHERE ${wh.join(' AND ')} ORDER BY t.code`, params));
  } catch (e) { next(e); }
});

r.get('/tools/:id/events', async (req, res, next) => {
  try {
    res.json(await q('SELECT * FROM tool_events WHERE tool_id=$1 ORDER BY id DESC', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Create ──────────────────────────────────────────────────────────────────
r.post('/tools', canManage, async (req, res, next) => {
  try {
    const { family, code, title } = req.body;
    if (!TOOL_FAMILIES[family]) return res.status(400).json({ error: 'Unknown tool family' });
    if (!title?.trim()) return res.status(400).json({ error: 'Tool needs a name' });
    const out = await tx(async (qc, oc) => {
      const finalCode = code?.trim() || await nextToolCode(family, oc);
      const dup = await oc('SELECT id FROM tools WHERE code=$1', [finalCode]);
      if (dup) throw Object.assign(new Error(`Code ${finalCode} already exists`), { status: 409 });
      const [t] = await qc(`
        INSERT INTO tools (family, code, title, product_id, maker, condition, location, notes,
                           ups, sheet_size, carton_size, colors, emboss_type, shade_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [family, finalCode, title.trim(), req.body.product_id || null, req.body.maker || null,
         req.body.condition || 'Good', req.body.location || null, req.body.notes || null,
         req.body.ups || null, req.body.sheet_size || null, req.body.carton_size || null,
         req.body.colors || null, req.body.emboss_type || null, req.body.shade_ref || null]);
      await qc(`INSERT INTO tool_events (tool_id, action, to_zone, user_name)
                VALUES ($1,'created','incoming',$2)`, [t.id, req.user.name]);
      return t;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Edit spec / condition / link ────────────────────────────────────────────
r.put('/tools/:id', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      const cols = EDIT_COLS.filter(c => req.body[c] !== undefined);
      if (!cols.length) return t;
      const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
      const vals = cols.map(c => (req.body[c] === '' ? null : req.body[c]));
      const [fresh] = await qc(`UPDATE tools SET ${sets} WHERE id=$${cols.length + 1} RETURNING *`,
        [...vals, t.id]);
      if (req.body.condition && req.body.condition !== t.condition) {
        await qc(`INSERT INTO tool_events (tool_id, action, note, user_name)
                  VALUES ($1,'condition',$2,$3)`,
          [t.id, `${t.condition} → ${req.body.condition}`, req.user.name]);
      }
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Zone move (the lifecycle) ───────────────────────────────────────────────
r.post('/tools/:id/move', canMove, async (req, res, next) => {
  try {
    const { zone, note } = req.body;
    if (!TOOL_ZONES.includes(zone)) return res.status(400).json({ error: 'Unknown zone' });
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      if (t.zone === zone) throw Object.assign(new Error(`Already in ${zone}`), { status: 409 });
      const [fresh] = await qc(
        'UPDATE tools SET zone=$1, zone_since=now() WHERE id=$2 RETURNING *', [zone, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'moved',$2,$3,$4,$5)`,
        [t.id, t.zone, zone, note || null, req.user.name]);
      const lines_ready = zone === 'in_rack' ? await autoFlip(fresh, qc, oc, req.user.name) : 0;
      return { ...fresh, lines_ready };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Undo the last move ──────────────────────────────────────────────────────
r.post('/tools/:id/undo', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      const ev = await oc(`SELECT * FROM tool_events WHERE tool_id=$1 AND action='moved'
                           ORDER BY id DESC LIMIT 1`, [t.id]);
      if (!ev || t.zone !== ev.to_zone) {
        throw Object.assign(new Error('Nothing to undo'), { status: 409 });
      }
      const [fresh] = await qc(
        'UPDATE tools SET zone=$1, zone_since=now() WHERE id=$2 RETURNING *', [ev.from_zone, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'undo',$2,$3,'Reversed last move',$4)`,
        [t.id, ev.to_zone, ev.from_zone, req.user.name]);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

export default r;
