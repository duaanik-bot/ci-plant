// One quotation: the customer's lines (final prices only — the costing never reaches it), the reply as the
// customer will read it, the PDF, and the one way out: a draft in Gmail. CI Plant never sends a mail (owner,
// 3 Nov 2026) — the person checks the draft and sends it from Gmail. Claude
// does the Gmail part through the AVS robot with exactly this text and this PDF.
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Mail } from 'lucide-react';
import { api, auth } from '../../api.js';
import { Button, ConfirmDialog, Field, Input, Modal, Textarea, useToast } from '../../components/ui.jsx';
import { JOB_LABEL, QUOTE_LABEL, QUOTE_TONE, dateText, mailboxTag, qtyText, rupees } from '../../lib/enquiryUi.js';

const EDITABLE = ['ready', 'drafted'];

// The customer's PDF as a local link, shown inside the page (a new window opened after the fetch would be
// stopped as a pop-up).
export async function quotationPdfUrl(id) {
  const res = await fetch(`/api/costing/quotations/${id}/pdf`, { headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {} });
  if (!res.ok) throw new Error('The PDF could not be made');
  return URL.createObjectURL(await res.blob());
}

export default function QuotationPanel({ id, canMarkSent, onClose, onChanged }) {
  const toast = useToast();
  const [qt, setQt] = useState(null);
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(null);   // 'draft' | 'cancel' | 'mark'
  const [pdf, setPdf] = useState(null);           // object URL of the preview
  const showPdf = async () => { try { setPdf(await quotationPdfUrl(id)); } catch (err) { toast.error(err.message); } };
  const closePdf = () => { if (pdf) URL.revokeObjectURL(pdf); setPdf(null); };
  const poll = useRef(null);

  const load = () => api.get(`/costing/quotations/${id}`).then(x => {
    setQt(x);
    setForm({ contact_email: x.contact_email || '', email_subject: x.email_subject || '', email_opening: x.email_opening || '',
      email_closing: x.email_closing || '', terms: x.terms || '' });
    setDirty(false);
    return x;
  });
  useEffect(() => {
    if (!id) return undefined;
    load().catch(() => onClose());
    return () => clearInterval(poll.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // While Claude has it, look again every few seconds.
  useEffect(() => {
    clearInterval(poll.current);
    if (qt?.status !== 'queued') return undefined;
    poll.current = setInterval(() => load().then(x => { if (x.status !== 'queued') onChanged?.(); }).catch(() => {}), 5000);
    return () => clearInterval(poll.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qt?.status]);

  if (!id) return null;
  const editable = qt && EDITABLE.includes(qt.status);
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };
  const save = async () => {
    const x = await api.put(`/costing/quotations/${id}`, form);
    setQt(x); setDirty(false);
    toast.success(`${x.quotation_no} saved`);
    onChanged?.();
  };
  const act = async kind => {
    if (kind === 'draft') {
      const r = await api.post(`/costing/quotations/${id}/draft`, {});
      toast.success(`Job ${r.job.id} queued — the draft appears in Gmail when the enquiry desk robot next runs`);
      setQt(r.quotation);
    } else if (kind === 'cancel') {
      setQt(await api.post(`/costing/quotations/${id}/cancel`, {}));
      toast.success('Quotation cancelled — its enquiries are ready to quote again');
    } else if (kind === 'mark') {
      setQt(await api.post(`/costing/quotations/${id}/mark-sent`, {}));
      toast.success('Marked as sent');
    }
    onChanged?.();
  };
  const r = qt?.recipient || {};
  const job = qt?.job;

  return (
    <Modal open={!!id} onClose={onClose} wide title={qt ? `Quotation ${qt.quotation_no} — ${qt.customer_name || qt.contact_email || ''}` : 'Opening…'}
      footer={qt && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {editable && <Button variant="secondary" onClick={() => setConfirm('cancel')}>Cancel quotation</Button>}
        <Button variant="secondary" onClick={showPdf}><FileText size={15} className="mr-1.5 inline" />Preview PDF</Button>
        {editable && dirty && <Button onClick={save}>Save changes</Button>}
        {qt.status === 'drafted' && canMarkSent && <Button variant="secondary" onClick={() => setConfirm('mark')}>Mark as sent</Button>}
        {editable && !dirty && !r.error && <Button onClick={() => setConfirm('draft')}><Mail size={15} className="mr-1.5 inline" />{qt.status === 'drafted' ? 'Save a fresh Gmail draft' : 'Save as a Gmail draft'}</Button>}
      </>}>
      {!qt ? <div className="p-6 text-sm text-slate-400">Opening…</div> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 font-bold ${QUOTE_TONE[qt.status]}`}>{QUOTE_LABEL[qt.status]}</span>
            {qt.mailbox_row && (
              <span className={`rounded-full px-2 py-0.5 font-bold ${mailboxTag(qt.mailbox_row).tone}`} title={mailboxTag(qt.mailbox_row).title}>
                From {mailboxTag(qt.mailbox_row).text}
              </span>
            )}
            {r.to && <span className="font-semibold text-slate-700">Draft addressed to {r.to}{r.trial ? ` — in business use it would go to ${r.would_go_to || '(no address yet)'}` : ''}</span>}
            {r.error && <span className="font-semibold text-red-700">{r.error}</span>}
            {qt.status === 'drafted' && <span className="font-semibold text-indigo-800">Waiting in Gmail — check it and send it from Gmail yourself</span>}
            {qt.gmail_draft_url && <a className="inline-flex items-center gap-1 font-bold text-brand-600 hover:underline" href={qt.gmail_draft_url} target="_blank" rel="noreferrer">Open the draft in Gmail <ExternalLink size={12} /></a>}
            {qt.sent_at && <span className="text-slate-600">Sent {dateText(qt.sent_at)} to {qt.sent_to} · {qt.sent_by_name}</span>}
          </div>
          {job && ['queued', 'working', 'failed'].includes(job.status) && (
            <div className={`rounded-xl px-3 py-2 text-sm ${job.status === 'failed' ? 'bg-red-50 text-red-800' : 'bg-sky-50 text-sky-800'}`}>
              {JOB_LABEL[job.kind]} — job {job.id}: {job.status === 'queued' ? 'waiting for Claude to pick it up' : job.status === 'working' ? `${job.claimed_by || 'Claude'} is on it` : `failed: ${job.error}`}
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr><th className="px-2 py-1.5">#</th><th className="px-2 py-1.5">Item</th><th className="px-2 py-1.5">Specification</th>
                  <th className="px-2 py-1.5 text-right">Quantity</th><th className="px-2 py-1.5 text-right">Rate a carton</th></tr>
              </thead>
              <tbody>
                {qt.lines.map((l, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1.5">{i + 1}</td>
                    <td className="px-2 py-1.5 font-semibold">{l.product}{l.size ? <span className="font-normal text-slate-500"> · {l.size} mm</span> : null}<div className="text-[11px] font-normal text-slate-400">{l.enquiry_no}</div></td>
                    <td className="px-2 py-1.5 text-xs text-slate-600">{l.specs || '—'}</td>
                    <td className="px-2 py-1.5 text-right">{qtyText(l.qty)}</td>
                    <td className="px-2 py-1.5 text-right font-bold">{rupees(l.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* The customer's copy has no amount and no total (owner, 3 Nov 2026); the value stays inside. */}
          <div className="-mt-2 text-[11px] text-slate-500">Value at the first quantity of each item: {rupees(qt.total)} — inside only, not on the customer's copy.</div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <Field label="Customer's e-mail"><Input value={form.contact_email} onChange={e => set('contact_email', e.target.value)} disabled={!editable} /></Field>
              <Field label="Subject" hint="For a Gmail draft or a new mail; a reply in the customer's thread keeps the thread's subject"><Input value={form.email_subject} onChange={e => set('email_subject', e.target.value)} disabled={!editable} /></Field>
              <Field label="Opening words"><Textarea value={form.email_opening} onChange={e => set('email_opening', e.target.value)} disabled={!editable} /></Field>
              <Field label="Closing words"><Textarea value={form.email_closing} onChange={e => set('email_closing', e.target.value)} disabled={!editable} /></Field>
              <Field label="Terms (on the PDF and in the mail)"><Textarea rows={4} value={form.terms} onChange={e => set('terms', e.target.value)} disabled={!editable} /></Field>
            </div>
            <div>
              <div className="mb-1 text-xs font-bold text-slate-600">What the customer will read{dirty ? ' (save to see your changes)' : ''}</div>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800">{qt.reply.text}</pre>
              <div className="mt-1 text-[11px] text-slate-500">Attached: {qt.quotation_no}.pdf. No costing figure is in the mail or the PDF — only the final prices above.</div>
            </div>
          </div>
        </div>
      )}
      <Modal open={!!pdf} onClose={closePdf} wide layer="nested" title={qt ? `${qt.quotation_no}.pdf — as the customer gets it` : 'PDF'}
        footer={<><a href={pdf || undefined} download={qt ? `${qt.quotation_no}.pdf` : 'quotation.pdf'} className="text-sm font-bold text-brand-600 hover:underline">Download</a><Button onClick={closePdf}>Close</Button></>}>
        {pdf && <iframe title="Quotation PDF" src={pdf} className="h-[70vh] w-full rounded-lg border border-slate-200 bg-white" />}
      </Modal>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => act(confirm)}
        title={{ draft: 'Save the reply as a Gmail draft?', cancel: 'Cancel this quotation?', mark: 'Mark as sent?' }[confirm]}
        confirmLabel={{ draft: 'Yes, save the draft', cancel: 'Cancel the quotation', mark: 'Yes, I sent it' }[confirm]}
        danger={confirm === 'cancel'}
        message={qt && ({
          draft: `Claude saves this reply, with ${qt.quotation_no}.pdf, as a draft in ${qt.mailbox_row?.email}, in the customer's thread "${qt.mail?.subject || 'a new mail'}", addressed to ${r.to}. Nothing is sent — you check the draft and send it from Gmail.${qt.status === 'drafted' ? ' The earlier draft stays in Gmail: delete it there.' : ''}`,
          cancel: 'Its enquiries go back to Quotation ready, so you can change prices or quote them again.',
          mark: 'Use this once you have sent the draft from Gmail. (The next Fetch also notices a draft you sent and marks it.)',
        })[confirm]} />
    </Modal>
  );
}
