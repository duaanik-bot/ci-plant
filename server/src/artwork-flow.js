// The artwork workflow's rules (owner, 17 Nov 2026: "buttons in sequence, like Send for Approval, and the status should
// be automatically updated in each run … the next process button should get automatically activated". Design:
// plans/2026-11-17-artwork-workflow-design.md). Pure, so they are tested on their own; the routes and the copier use them.
import { parseItemCode } from './artwork-register.js';

// The stages of a version, in order, and what each shows.
export const STAGES = {
  new:           { label: 'New — waiting for the designer', short: 'New' },
  designer_file: { label: "Designer's file in", short: 'Designer file in' },
  proof_ready:   { label: 'Proof ready to send', short: 'Proof ready' },
  approval_sent: { label: 'Approval sent', short: 'Approval sent' },
  approved:      { label: 'Approval received', short: 'Approved' },
  changes:       { label: 'Changes asked', short: 'Changes asked' },
  to_confirm:    { label: 'To confirm — a reply nobody could read for sure', short: 'To confirm' },
  released:      { label: 'Released to plates', short: 'Released' },
};

const NEXT = {
  new: [], designer_file: ['send_for_approval'], proof_ready: ['send_email', 'cancel_draft'],
  approval_sent: ['decide'], to_confirm: ['decide'], changes: ['decide'], approved: ['release'], released: [],
};
// The buttons a version offers now. A deleted, superseded or not-artwork version offers none (restore is separate).
export function actionsFor(v) {
  if (!v || v.deleted_at || v.superseded || v.status === 'not_artwork') return [];
  return [...(NEXT[v.stage] || [])];
}

export const proofNo = (jobNo, label, n) => `PRF-${jobNo}-${label}-${n}`;

// Where an export can go: a version still waiting for the designer's file, or sent back.
const OPEN = new Set(['new', 'designer_file', 'changes', 'to_confirm']);
// The designer's export → the version it is for, by the item code and revision in its file name. Never a guess: no
// code, no open version, or two open versions with no revision to tell them apart → { why } and a person picks.
// candidates: [{ version_id, client_item_code, client_rev, stage }]
export function matchExport(fileName, candidates) {
  const { code, rev } = parseItemCode(fileName);
  if (!code) return { why: 'no item code in the file name — pick the job by hand' };
  const open = candidates
    .filter(c => String(c.client_item_code || '').toUpperCase() === code && OPEN.has(c.stage) && !c.deleted_at)
    .filter(c => !rev || String(c.client_rev || '').toUpperCase() === rev)
    .sort((a, b) => b.version_id - a.version_id);
  if (!open.length) return { why: `no open version of ${code}${rev ? ` ${rev}` : ''} waiting for the designer's file — pick the job by hand` };
  if (!rev) {
    const byJob = new Set(open.map(c => `${c.client_item_code}|${c.client_rev}`));
    if (byJob.size > 1 || open.length > 1) return { why: `${open.length} open versions of ${code} and no revision in the file name — pick the job by hand` };
  }
  return { version_id: open[0].version_id };
}

// One approval mail per client thread, in the order the versions were picked. A version with no thread goes alone.
export function groupByThread(versions) {
  const groups = new Map();
  versions.forEach((v, i) => {
    const key = v.gmail_thread_id ? `t:${v.gmail_thread_id}` : `v:${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  });
  return [...groups.values()];
}

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(1)));
// The approval mail, in the house's words ("Please Provide Approval,"), one line per proof.
export function proofMailText({ subject, proofs }) {
  const s = String(subject || '').trim() || 'Artwork for approval';
  const lines = proofs.map((p, i) => {
    const w = num(p.page_w_mm), h = num(p.page_h_mm);
    const bits = [p.proof_no, p.product_name, [p.client_item_code, p.label].filter(Boolean).join(' '),
      w && h ? `${w} × ${h} mm` : null, (p.colours || []).length ? p.colours.join(', ') : null].filter(Boolean);
    return `${i + 1}. ${bits.join(' — ')}`;
  });
  const text = ['Dear Sir/Madam,', '', 'Please Provide Approval,', '',
    `The proof${proofs.length === 1 ? ' is' : 's are'} attached:`, ...lines, '',
    'Please check the design, text and colours, and quote the proof number when you reply.', '',
    'Regards,', 'Artwork & PPIC', 'Colour Impressions'].join('\n');
  return { subject: /^re:/i.test(s) ? s : `Re: ${s}`, text };
}

// A client's reply → the versions it moves. Approval only when the reply says which proof, or the mail had one proof;
// anything the robot could not read for sure goes to a person (to_confirm). mailVersions: [{ version_id, proof_no }]
const VERDICT = { approval: 'approved', changes: 'changes', unclear: 'to_confirm' };
export function applyVerdict({ verdict, proof_nos = [] }, mailVersions) {
  const named = new Set((proof_nos || []).map(p => String(p).trim().toUpperCase()));
  const hit = mailVersions.filter(v => named.has(String(v.proof_no || '').toUpperCase()));
  const stage = VERDICT[verdict] || 'to_confirm';
  if (hit.length) return hit.map(v => ({ version_id: v.version_id, stage }));
  // a reply that names proofs, none of them the one out (an older proof, another job's): never an approval
  if (named.size) return mailVersions.map(v => ({ version_id: v.version_id, stage: 'to_confirm' }));
  if (mailVersions.length === 1) return [{ version_id: mailVersions[0].version_id, stage }];
  return mailVersions.map(v => ({ version_id: v.version_id, stage: 'to_confirm' }));
}
