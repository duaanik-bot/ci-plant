// The artwork workflow on screen (owner, 17 Nov 2026): the stages, their words and colours, the buttons, and the
// "Upload designer's PDF" fallback (the same pieces the CorelDRAW button sends). Server: routes/artwork-flow.js.
import { api, auth } from '../../api.js';

export const STAGES = [
  { key: 'new', label: 'New', long: 'New — waiting for the designer', tone: 'slate' },
  { key: 'designer_file', label: 'Designer file in', long: "Designer's file in — ready to send for approval", tone: 'blue' },
  { key: 'proof_ready', label: 'Proof ready', long: 'Proof and mail ready — review, then Send email', tone: 'violet' },
  { key: 'approval_sent', label: 'Approval sent', long: 'Approval sent — waiting for the client', tone: 'amber' },
  { key: 'approved', label: 'Approved', long: 'Approval received', tone: 'green' },
  { key: 'changes', label: 'Changes asked', long: 'Changes asked by the client', tone: 'red' },
  { key: 'to_confirm', label: 'To confirm', long: 'A reply nobody could read for sure — decide by hand', tone: 'orange' },
  { key: 'released', label: 'Released', long: 'Released to plates', tone: 'emerald' },
];
export const stageOf = key => STAGES.find(s => s.key === key) || STAGES[0];
export const TONE = {
  slate: 'bg-slate-100 text-slate-700', blue: 'bg-sky-50 text-sky-800', violet: 'bg-violet-50 text-violet-800', amber: 'bg-amber-50 text-amber-800',
  green: 'bg-green-50 text-green-800', red: 'bg-red-50 text-red-800', orange: 'bg-orange-50 text-orange-800', emerald: 'bg-emerald-50 text-emerald-800',
};
// The path a version normally walks, for the step strip.
export const PATH = ['new', 'designer_file', 'proof_ready', 'approval_sent', 'approved', 'released'];

export const ACTIONS = {
  send_for_approval: { label: 'Send for approval', hint: 'Builds the stamped proof, the reply-all draft and the Drive copy. Nothing is sent.' },
  send_email: { label: 'Send email', hint: 'Sends the reviewed draft from mppchd to the client.' },
  cancel_draft: { label: 'Cancel draft', hint: 'Back to "designer file in". Delete the draft in Gmail.' },
  decide: { label: 'Approve / Changes', hint: 'Record the client\'s answer by hand, with a note.' },
  release: { label: 'Send to plates', hint: 'Recorded with who and when.' },
};

const sha256 = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');

// "Upload designer's PDF": the file in pieces, as the CorelDRAW button sends it. → the server's answer to finish.
export async function uploadExport(file, versionId, onProgress = () => {}) {
  const buf = await file.arrayBuffer();
  const start = await api.post(`/artwork/register/versions/${versionId}/export/start`, {
    file_name: file.name, size_bytes: buf.byteLength, sha256: await sha256(buf),
  });
  for (let i = 0; i < start.chunks; i++) {
    const piece = buf.slice(i * start.chunk_size, (i + 1) * start.chunk_size);
    const res = await fetch(`/api/artwork/register/export/${start.upload}/chunk/${i}`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${auth.token}` }, body: piece,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Piece ${i + 1} was refused (${res.status}).`);
    onProgress((i + 1) / start.chunks);
  }
  return api.post(`/artwork/register/export/${start.upload}/finish`, {});
}

// One line a person reads after a button: what happened and what was skipped, with why.
export function summary(out) {
  const done = (out.drafts?.length || 0) + (out.sent?.length || 0) + (out.moved?.length || 0) + (out.cancelled?.length || 0) + (out.deleted?.length || 0) + (out.restored?.length || 0);
  const why = (out.skipped || []).map(s => `${s.label || `mail ${s.proof_mail_id}`}: ${s.why}`);
  return { done, why };
}
