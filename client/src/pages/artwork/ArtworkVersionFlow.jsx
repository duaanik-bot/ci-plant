// One version's workflow inside the artwork window (owner, 17 Nov 2026): where it stands, the one next button, the
// designer's exports, the proofs, and the approval mail exactly as it will go — to, cc, subject, text, attachments.
import { useRef, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, Field, Modal, Textarea, useToast } from '../../components/ui.jsx';
import { Check, ExternalLink, FileUp, Mail, Send } from 'lucide-react';
import { ACTIONS, PATH, STAGES, TONE, stageOf, summary, uploadExport } from './artworkFlow.js';

function Out({ href, children }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#0064D2] hover:underline">{children}<ExternalLink size={11} /></a>;
}

export function StageBadge({ stage }) {
  const s = stageOf(stage);
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[s.tone]}`}>{s.label}</span>;
}

// new → designer file → proof ready → approval sent → approved → released, the done steps ticked
function StepStrip({ stage }) {
  const at = PATH.indexOf(stage);
  const off = at < 0;           // changes / to_confirm sit beside the path
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      {PATH.map((k, i) => {
        const done = !off && i < at, now = !off && i === at;
        return (
          <span key={k} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${now ? 'bg-[#0064D2] font-semibold text-white' : done ? 'bg-green-50 text-green-800' : 'bg-slate-50 text-slate-400'}`}>
            {done && <Check size={10} />}{STAGES.find(s => s.key === k).label}
          </span>
        );
      })}
      {off && <span className={`rounded-full px-2 py-0.5 font-semibold ${TONE[stageOf(stage).tone]}`}>{stageOf(stage).long}</span>}
    </div>
  );
}

export default function ArtworkVersionFlow({ v, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);
  const draft = (v.proof_mails || []).find(m => m.status === 'draft' || m.status === 'sending');
  const lastSent = (v.proof_mails || []).find(m => m.status === 'sent');

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const out = await fn();
      const s = summary(out);
      if (s.done) toast.success(ok);
      if (s.why.length) toast.error(s.why.join(' · '));
      onDone?.();
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const act = {
    send_for_approval: () => run('sfa', () => api.post('/artwork/register/send-for-approval', { version_ids: [v.id] }), 'Proof, draft and Drive copy made — review the mail below, then Send email'),
    send_email: () => draft && window.confirm(`Send the approval mail now?\n\nTo: ${draft.to_text}${draft.cc_text ? `\nCc: ${draft.cc_text}` : ''}\nSubject: ${draft.subject}\nAttached: ${draft.attachments.map(a => a.name).join(', ')}`)
      && run('send', () => api.post('/artwork/register/send-email', { proof_mail_ids: [draft.id] }), 'Approval mail sent'),
    cancel_draft: () => draft && run('cancel', () => api.post('/artwork/register/cancel-draft', { proof_mail_ids: [draft.id] }), 'Draft cancelled — delete it in Gmail'),
    decide: () => { setNote(''); setDeciding(true); },
    release: () => run('release', () => api.post('/artwork/register/release', { version_ids: [v.id] }), 'Released to plates'),
  };
  const upload = async file => {
    if (!file) return;
    setProgress(0);
    try {
      const out = await uploadExport(file, v.id, setProgress);
      toast.success(out.matched ? `${file.name} is in — Send for approval is ready` : `${file.name} is in, but: ${out.why}`);
      onDone?.();
    } catch (e) { toast.error(e.message); } finally { setProgress(null); if (fileRef.current) fileRef.current.value = ''; }
  };
  const decide = verdict => run('decide', () => api.post('/artwork/register/decide', { version_ids: [v.id], verdict, note }), verdict === 'approved' ? 'Approved' : 'Changes asked')
    .then(() => setDeciding(false));

  const live = !v.deleted_at && !v.superseded && v.status !== 'not_artwork';
  return (
    <div className="mt-2 space-y-2 rounded-xl bg-slate-50/70 p-2.5">
      <StepStrip stage={v.stage} />
      {v.superseded && <div className="text-[12px] text-slate-500">Superseded by a newer version.</div>}
      {v.decided_note && <div className="text-[12px] text-slate-600">Decided by hand: {v.decided_note}</div>}

      {live && (
        <div className="flex flex-wrap items-center gap-2">
          {v.actions.map((a, i) => (
            <Button key={a} size="sm" variant={i === 0 ? 'primary' : 'secondary'} disabled={!!busy} onClick={act[a]} title={ACTIONS[a].hint}>
              {a === 'send_email' && <Send size={13} className="mr-1 inline" />}{busy && i === 0 ? 'Working…' : ACTIONS[a].label}
            </Button>
          ))}
          {['new', 'designer_file', 'changes', 'to_confirm'].includes(v.stage) && (
            <>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={e => upload(e.target.files?.[0])} />
              <Button size="sm" variant="secondary" disabled={progress != null} onClick={() => fileRef.current?.click()}>
                <FileUp size={13} className="mr-1 inline" />{progress != null ? `Uploading ${Math.round(progress * 100)}%` : "Upload designer's PDF"}
              </Button>
            </>
          )}
          {!v.actions.length && v.stage === 'new' && <span className="text-[12px] text-slate-500">Waiting for the designer to press Export for CI Plant in CorelDRAW.</span>}
          <Button size="sm" variant="secondary" className="ml-auto" disabled={!!busy} onClick={() => {
            const reason = window.prompt(`Delete ${v.label}? It is hidden, kept with the reason, and can be put back.\n\nWhy?`);
            if (reason && reason.trim()) run('delete', () => api.post('/artwork/register/delete', { version_ids: [v.id], reason }), `${v.label} deleted`);
          }}>Delete</Button>
        </div>
      )}
      {v.deleted_at && (
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run('restore', () => api.post('/artwork/register/restore', { version_ids: [v.id] }), `${v.label} put back`)}>Put back</Button>
      )}

      {!!v.exports?.length && (
        <div className="text-[12px]">
          <div className="font-semibold text-slate-600">Designer's export</div>
          {v.exports.map(e => (
            <div key={e.id} className="flex flex-wrap items-center gap-2 text-slate-700">
              <span className="font-semibold">{e.file_name}</span>
              <span className="text-slate-500">{[e.page_w_mm && e.page_h_mm ? `${e.page_w_mm} × ${e.page_h_mm} mm` : null, (e.colours || []).join(', ') || null, e.by_name, fmt.date(e.created_at)].filter(Boolean).join(' · ')}</span>
              {e.drive_url && <Out href={e.drive_url}>Open in Drive</Out>}
            </div>
          ))}
        </div>
      )}

      {(draft || lastSent) && (() => {
        const m = draft || lastSent;
        return (
          <div className="rounded-lg border border-slate-200 bg-white p-2 text-[12px]">
            <div className="mb-1 flex flex-wrap items-center gap-2 font-semibold text-slate-700"><Mail size={12} />
              {draft ? 'The approval mail, as it will go' : `Approval mail sent ${fmt.date(m.sent_at)} by ${m.sent_by}`}
              {m.draft_url && draft && <Out href={m.draft_url}>Open draft in Gmail</Out>}
            </div>
            <div><span className="text-slate-500">To:</span> {m.to_text}</div>
            {m.cc_text && <div><span className="text-slate-500">Cc:</span> {m.cc_text}</div>}
            <div><span className="text-slate-500">Subject:</span> {m.subject}</div>
            <div className="text-slate-500">Attached:</div>
            {m.attachments.map(a => <div key={a.name} className="ml-2">{a.name} {a.drive_url && <Out href={a.drive_url}>Open proof</Out>}</div>)}
            <pre className="mt-1 whitespace-pre-wrap font-sans text-[12px] text-slate-700">{m.body_text}</pre>
            {m.error && <div className="mt-1 text-red-700">Last try: {m.error}</div>}
          </div>
        );
      })()}

      {!!v.fluence?.length && (
        <div className="text-[12px]">
          {v.fluence.map(f => (
            <div key={f.id} className="text-slate-700">
              <span className="font-semibold">Fluence:</span> prescription and MRPs read{f.read_from ? ` from ${f.read_from}` : ''} —{' '}
              {{ waiting_approval: 'saved to the Fluence master when the client approves this version',
                queued: 'being saved to the Fluence master',
                saved: `saved to the Fluence master${f.changes?.rx_changed ? ` (prescription revision ${f.changes.revision})` : ''}${f.created_product_id ? ', new kit made' : ''}`,
                same: 'the Fluence master already says this', held: `held: ${f.hold_reason}`, not_matched: 'no kit matched', undone: 'undone',
                dismissed: 'not saved — the master kept as it was',
              }[f.status] || f.status}{' '}
              <a href="/fluence?tab=mail" className="font-semibold text-[#0064D2] hover:underline">Open in Fluence</a>
            </div>
          ))}
        </div>
      )}

      {!!v.proofs?.filter(p => p.by_hand).length && (
        <div className="text-[12px] text-slate-600">Proof sent by hand from Gmail: {v.proofs.filter(p => p.by_hand).map(p => p.file_name || 'file').join(', ')}</div>
      )}

      <Modal open={deciding} onClose={() => setDeciding(false)} title={`${v.label} — the client's answer`} layer={2}
        footer={<>
          <Button variant="secondary" onClick={() => setDeciding(false)}>Cancel</Button>
          <Button variant="danger" disabled={!note.trim() || !!busy} onClick={() => decide('changes')}>Changes asked</Button>
          <Button disabled={!note.trim() || !!busy} onClick={() => decide('approved')}>Approved</Button>
        </>}>
        <p className="mb-2 text-sm text-slate-600">Approving ticks "customer OK" on this product's open order lines.</p>
        <Field label="How did the client answer?" required>
          <Textarea autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder='e.g. "Approved on WhatsApp by the buyer, 17 Nov"' />
        </Field>
      </Modal>
    </div>
  );
}
