// What really happened to an approval mail, asked of Gmail (review of 17 Nov 2026: never send twice, never stay stuck).
//
// A Send email cut off by the 30-second limit after Gmail took the mail, a draft someone sent from Gmail itself, a
// draft deleted in Gmail: CI Plant cannot know from its own rows. So, for the mails that need it, it looks:
//   'sending' for over a minute   → sent (draft gone, a sent mail in the thread) is recorded as sent; else back to a
//                                   draft with the reason — never sent blind a second time
//   'draft' (looked at once in 10 min) → sent from Gmail is recorded as sent; a draft gone unsent says so
//   'cancelled', still in Gmail   → the Gmail draft is deleted, so nobody sends it by mistake
// Called by Send email, the robot's call (before it reads replies) and the two-minute poll; never fails its caller.
import { q, one, tx } from './db.js';
import { audit } from './helpers.js';
import { approvalSent, deleteDraft } from './gmail.js';
import { businessDrive } from './artwork-upload.js';
import { moveStage } from './artwork-approval.js';

const GONE = 'The draft is no longer in Gmail and was not sent — press Cancel draft, then Send for approval again.';

// Record an approval mail as sent (by CI Plant, or found sent in Gmail): the mail, its proofs' send time, the stage.
// Inside a transaction already open (the copier) use markSentIn; elsewhere markSent.
export async function markSentIn(qc, oc, pmId, { at = new Date().toISOString(), messageId = null, by }) {
  const pm = await oc(`UPDATE artwork_proof_mails SET status = 'sent', sent_at = $2, gmail_message_id = COALESCE($3, gmail_message_id),
                                                     sent_by = COALESCE(sent_by, $4), error = NULL
                        WHERE id = $1 AND status IN ('draft', 'sending') RETURNING id, version_ids, to_text`, [pmId, at, messageId, by]);
  if (!pm) return false;
  await qc(`UPDATE artwork_proofs SET sent_at = $2 WHERE proof_mail_id = $1 AND sent_at IS NULL`, [pmId, at]);
  await moveStage(qc, { versionIds: pm.version_ids, to: 'approval_sent', from: ['proof_ready'], by, action: 'approval_sent', detail: { proof_mail_id: pmId } });
  await audit('artwork_proof_mail', pmId, 'send', `Approval mail sent to ${pm.to_text} (${by})`, qc, by);
  return true;
}
export const markSent = (pmId, opts) => tx((qc, oc) => markSentIn(qc, oc, pmId, opts));

// The drafts of these versions are no longer to be sent (a newer file came, the version was deleted or marked not
// artwork, the designer sent a proof by hand). They are marked cancelled; every OTHER version on those mails still
// waiting at "proof ready" goes back to "designer file in", so it can be built again (it is not left with no mail).
// The Gmail draft is deleted by the caller or the next settle.
export async function cancelDraftsOf(qc, versionIds, why, by = 'CI Plant') {
  if (!versionIds.length) return [];
  const cancelled = await qc(`UPDATE artwork_proof_mails SET status = 'cancelled', error = $2
                               WHERE status = 'draft' AND version_ids && $1::int[] RETURNING id, gmail_draft_id, version_ids`, [versionIds, why]);
  const others = [...new Set(cancelled.flatMap(c => c.version_ids))];
  if (others.length) {
    await moveStage(qc, { versionIds: others, to: 'designer_file', from: ['proof_ready'], by, action: 'draft_cancelled', detail: { why } });
  }
  return cancelled;
}

const GONE_UNSENT = GONE;
export async function settleProofMails({ max = 5, ids = null } = {}) {
  const rows = await q(`
    SELECT * FROM artwork_proof_mails
     WHERE ($2::int[] IS NULL OR id = ANY($2::int[]))
       AND ((status = 'sending' AND claimed_at < now() - interval '1 minute')
         OR (status = 'draft' AND created_at < now() - interval '2 minutes' AND (checked_at IS NULL OR checked_at < now() - interval '10 minutes'))
         OR (status = 'cancelled' AND gmail_draft_id IS NOT NULL AND draft_deleted_at IS NULL))
     ORDER BY id LIMIT $1`, [max, ids]);
  const out = { sent: 0, back: 0, deleted: 0 };
  if (!rows.length) return out;
  let drive;
  try { drive = await businessDrive(); } catch { return out; }      // Gmail not connected: nothing can be asked
  for (const pm of rows) {
    try {
      if (pm.status === 'cancelled') {
        await deleteDraft(drive.token, { draftId: pm.gmail_draft_id });
        await q(`UPDATE artwork_proof_mails SET draft_deleted_at = now() WHERE id = $1`, [pm.id]);
        out.deleted += 1;
        continue;
      }
      const s = await approvalSent(drive.token, { draftId: pm.gmail_draft_id, threadId: pm.gmail_thread_id, marker: pm.mail_token });
      if (s.sent) {
        if (await markSent(pm.id, { at: s.at, messageId: s.message_id, by: pm.sent_by || 'Gmail (sent outside CI Plant)' })) out.sent += 1;
      } else if (pm.status === 'sending') {
        await q(`UPDATE artwork_proof_mails SET status = 'draft', error = $2 WHERE id = $1 AND status = 'sending'`,
          [pm.id, s.gone ? GONE : 'The send did not finish and the mail did not go — press Send email again.']);
        out.back += 1;
      } else {
        await q(`UPDATE artwork_proof_mails SET checked_at = now(), error = CASE WHEN $2 THEN $3 ELSE error END WHERE id = $1 AND status = 'draft'`, [pm.id, !!s.gone, GONE_UNSENT]);
      }
    } catch (e) { console.warn(`[artwork-settle] mail ${pm.id}: ${e.message}`); }
  }
  return out;
}

// For the poll and the robot: only when something needs it, and never failing the caller.
export async function settleProofMailsSoft() {
  try {
    const need = await one(`SELECT 1 AS y FROM artwork_proof_mails
                             WHERE (status = 'sending' AND claimed_at < now() - interval '1 minute')
                                OR (status = 'draft' AND created_at < now() - interval '2 minutes' AND (checked_at IS NULL OR checked_at < now() - interval '10 minutes'))
                                OR (status = 'cancelled' AND gmail_draft_id IS NOT NULL AND draft_deleted_at IS NULL) LIMIT 1`);
    return need ? await settleProofMails() : { sent: 0, back: 0, deleted: 0 };
  } catch (e) {
    if (!['42P01', '3F000'].includes(e?.code)) console.warn(`[artwork-settle] ${e.message}`);
    return { sent: 0, back: 0, deleted: 0 };
  }
}
