// Machine Logbook — one chronological register per machine, ISO-style.
//
// Every machine in the master appears here (active or not — history must stay
// readable after a machine retires). Each register merges two sources:
//   auto   : production runs derived live from job_stages (which product ran,
//            when, quantities, operator) — never re-entered, never drifts.
//   manual : machine_log_entries — setup, maintenance, breakdown, idle, remarks
//            entered from the Logbook page.
// A stage belongs to a machine via js.machine_id (picked at the section), or —
// for printing only — the press assigned in Print Planning (jc.machine_id),
// mirroring how the Live Floor resolves machine names.
import { Router } from 'express';
import { q, one } from '../db.js';
import { requireRole } from '../auth.js';
import { audit } from '../helpers.js';

const r = Router();
const canWrite = requireRole('production', 'planner'); // admin implied

const EFFECTIVE_MACHINE =
  `COALESCE(js.machine_id, CASE WHEN js.stage='printing' THEN jc.machine_id END)`;

// Every machine in the master + assigned operators + last recorded activity
// (production or manual) so the rail shows which registers are alive.
r.get('/logbook/machines', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators,
             GREATEST(run.last_at, man.last_at) AS last_activity,
             COALESCE(run.runs_30d, 0) AS runs_30d
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id = mo.employee_id
        WHERE mo.machine_id = m.id AND e.active = 1) ops ON true
      LEFT JOIN LATERAL (
        SELECT MAX(js.started_at) AS last_at,
               COUNT(*) FILTER (WHERE js.started_at >= now() - interval '30 days') AS runs_30d
        FROM job_stages js JOIN job_cards jc ON jc.id = js.job_card_id
        WHERE ${EFFECTIVE_MACHINE} = m.id AND js.started_at IS NOT NULL) run ON true
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_at FROM machine_log_entries
        WHERE machine_id = m.id) man ON true
      ORDER BY m.type, m.name`);
    res.json(rows);
  } catch (e) { next(e); }
});

// The register itself for one machine over a date window (inclusive).
// Auto rows key off the shift the run STARTED in; manual rows off log_date.
r.get('/logbook/machines/:id', async (req, res, next) => {
  try {
    const machine = await one(`
      SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id = mo.employee_id
        WHERE mo.machine_id = m.id AND e.active = 1) ops ON true
      WHERE m.id = $1`, [req.params.id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';

    const runs = await q(`
      SELECT js.id, js.stage, js.status, js.unit, js.qty_in, js.qty_out, js.qty_scrap,
             js.operator, js.remarks, js.hold_reason, js.started_at, js.completed_at,
             jc.jc_number, jc.id AS job_card_id,
             p.name AS product_name, p.code AS product_code,
             c.name AS customer_name, o.po_number
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE ${EFFECTIVE_MACHINE} = $1
        AND js.started_at IS NOT NULL
        AND js.started_at::date BETWEEN $2::date AND $3::date
      ORDER BY js.started_at`, [machine.id, from, to]);

    const manual = await q(`
      SELECT * FROM machine_log_entries
      WHERE machine_id = $1 AND log_date BETWEEN $2 AND $3
      ORDER BY log_date, time_from NULLS LAST, id`, [machine.id, from, to]);

    // One normalized shape for the register — the client renders and exports
    // auto and manual rows through the same columns.
    const entries = [
      ...runs.map(s => ({
        kind: 'auto', id: `run-${s.id}`,
        ts: s.started_at,
        date: s.started_at, time_from: s.started_at, time_to: s.completed_at,
        entry_type: 'production', stage: s.stage, status: s.status,
        description: `${s.product_name} (${s.product_code})`,
        ref: s.jc_number, po_number: s.po_number, customer_name: s.customer_name,
        unit: s.unit, qty_in: s.qty_in, qty_out: s.qty_out, qty_scrap: s.qty_scrap,
        operator: s.operator,
        remarks: [s.hold_reason && `Hold: ${s.hold_reason}`, s.remarks].filter(Boolean).join(' · ') || null,
      })),
      ...manual.map(e => ({
        kind: 'manual', id: `man-${e.id}`, entry_id: e.id,
        ts: `${e.log_date}T${e.time_from || '00:00'}`,
        date: e.log_date, time_from: e.time_from, time_to: e.time_to,
        entry_type: e.entry_type, stage: null, status: 'logged',
        description: e.description,
        ref: null, po_number: null, customer_name: null,
        unit: null, qty_in: null, qty_out: e.qty, qty_scrap: null,
        operator: e.operator,
        remarks: e.remarks, created_by: e.created_by,
      })),
    ].sort((a, b) => new Date(a.ts) - new Date(b.ts));

    res.json({ machine, from, to, entries });
  } catch (e) { next(e); }
});

// Manual register entry — the operator's pen line in the logbook.
r.post('/logbook/machines/:id/entries', canWrite, async (req, res, next) => {
  try {
    const machine = await one('SELECT * FROM machines WHERE id=$1', [req.params.id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const { log_date, time_from, time_to, entry_type, description, operator, qty, remarks } = req.body;
    if (!log_date || !description?.trim()) {
      return res.status(400).json({ error: 'Date and description are required' });
    }
    const [row] = await q(`
      INSERT INTO machine_log_entries
        (machine_id, log_date, time_from, time_to, entry_type, description, operator, qty, remarks, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [machine.id, log_date, time_from || null, time_to || null, entry_type || 'remark',
       description.trim(), operator || null, qty ?? null, remarks || null, req.user.name]);
    await audit('machine', machine.id, 'logbook_entry',
      `${machine.name}: ${entry_type || 'remark'} — ${description.trim()}`, q, req.user.name);
    res.json(row);
  } catch (e) { next(e); }
});

// Correcting a wrong pen line — allowed, but audited with what was struck out.
r.delete('/logbook/entries/:id', canWrite, async (req, res, next) => {
  try {
    const entry = await one('SELECT * FROM machine_log_entries WHERE id=$1', [req.params.id]);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    await q('DELETE FROM machine_log_entries WHERE id=$1', [entry.id]);
    await audit('machine', entry.machine_id, 'logbook_entry_delete',
      `${entry.log_date} ${entry.entry_type}: ${entry.description}`, q, req.user.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
