// The AVS audit trail (avs.audit_log, append only — the database refuses any
// change or removal). Every cancel, delete, redo, Verify, Try again and QA
// decision made in CI Plant is written here with who, when and why, so a check
// that was stopped or deleted can always be traced (owner's request, 1 Oct 2026).
//
// `run` is q or a transaction's qc: a delete and its audit row are saved
// together or not at all.
import { AVS_REMARK_MAX } from '../../client/src/lib/avs.js';

export async function avsAudit(run, { action, reportNo = null, setId = null, user = null, reason = null, details = null }) {
  await run(`INSERT INTO avs.audit_log (action, report_no, set_id, actor, actor_user_id, actor_role, reason, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [action, reportNo, setId, user?.name ?? null, user?.id ?? null, user?.role ?? null,
    reason ? String(reason).slice(0, AVS_REMARK_MAX) : null, details ? JSON.stringify(details) : null]);
}

// For steps whose own record already exists (a decision row, a Verify): the
// trail line is written, but a database without avs.audit_log (a local one
// before the migration) never stops the step itself.
export async function avsAuditSoft(run, entry) {
  try { await avsAudit(run, entry); } catch (e) {
    if (!['42P01', '3F000'].includes(e?.code)) console.warn('[avs] audit:', e.message);
  }
}
