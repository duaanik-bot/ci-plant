// ─── HR's own audit trail ───────────────────────────────────────────────────
// Every HR write leaves a row in hr.audit_log: who (from req.user), what (entity and
// its id), the action and a JSON detail. Never the plant's audit_log, which /timeline
// shows to every login. The table is append-only — the database refuses any UPDATE,
// DELETE or TRUNCATE of it (supabase/migrations/20261016120000_hr_payroll.sql).
//
// `qc` is the transaction's query function from tx((qc, oc) => …), so the write and
// its audit row are saved together or not at all — and inside a transaction nothing
// may use the pool (a one-client pool on Vercel would wait on itself).
//
// entity_id is text: runs and people have ids, settings and pay channels have keys.
// detail is always sent as JSON text: node-pg would turn a bare JS array into a
// Postgres array literal, which is not JSON.
const SQL = `INSERT INTO hr.audit_log (user_id, user_name, entity, entity_id, action, detail)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING id, at`;

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export async function hrAudit(qc, req, entity, entityId, action, detail = null) {
  if (typeof qc !== 'function') throw new TypeError('hrAudit: pass the transaction query function (qc)');
  if (!nonEmpty(entity)) throw new TypeError('hrAudit: entity must be a non-empty string');
  if (!nonEmpty(action)) throw new TypeError('hrAudit: action must be a non-empty string');
  const raw = req?.user?.id;
  const id = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
  const userId = Number.isSafeInteger(id) && id > 0 ? id : null;
  const userName = typeof req?.user?.name === 'string' ? req.user.name : null;
  const rows = await qc(SQL, [
    userId,
    userName,
    entity,
    entityId === null || entityId === undefined ? null : String(entityId),
    action,
    detail === null || detail === undefined ? null : JSON.stringify(detail),
  ]);
  return rows?.[0] ?? null;
}
