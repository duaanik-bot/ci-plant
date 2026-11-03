// One enquiry: what was asked (a person corrects what Claude read), the original mail, its costing, its
// prices and its history. Also the form for an enquiry typed in by hand (phone, WhatsApp): id = 'new'.
import { useEffect, useState } from 'react';
import { ExternalLink, Mail, Paperclip } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '../../components/ui.jsx';
import { STYLES, styleLabel } from '../../lib/costing.js';
import { STAGE_TONE, dateText, parseQuantities, quantitiesText, qtyText, rupees } from '../../lib/enquiryUi.js';

const STYLE_OPTIONS = Object.keys(STYLES);
const EMPTY = {
  customer_name: '', contact_name: '', contact_email: '', product_name: '', size_text: '', style: '', board: '', gsm: '',
  colours: '', coating: '', specs: '', quantities: '', target_price: '', notes: '',
};
const formOf = e => ({
  customer_name: e.customer_name || '', contact_name: e.contact_name || '', contact_email: e.contact_email || '',
  product_name: e.product_name || '', size_text: e.size_text || '', style: e.style || '', board: e.board || '',
  gsm: e.gsm ?? '', colours: e.colours ?? '', coating: e.coating || '', specs: e.specs || '',
  quantities: (e.quantities || []).join(', '), target_price: e.target_price ?? '', notes: e.notes || '',
});
const EVENT_TEXT = {
  fetched: 'Read from the mailbox', added: 'Typed in by hand', details: 'Details changed', ready: 'Marked ready for costing',
  push: 'Pushed to costing', costing: 'Costing linked', price: 'Final price saved', finalise: 'Prices finalised',
  reopen: 'Prices reopened', quotation: 'Put on a quotation', sent: 'Quotation sent', drop: 'Dropped', restore: 'Brought back',
};

export default function EnquiryDetail({ id, statuses, onClose, onChanged, onOpenCosting }) {
  const toast = useToast();
  const [e, setE] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [dirty, setDirty] = useState(false);
  const isNew = id === 'new';

  useEffect(() => {
    if (!id) return;
    if (isNew) { setE(null); setForm(EMPTY); setDirty(false); return; }
    api.get(`/costing/enquiries/${id}`).then(x => { setE(x); setForm(formOf(x)); setDirty(false); }).catch(() => onClose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };
  const locked = e && ['quote_ready', 'sent'].includes(e.status);
  const save = async () => {
    const body = { ...form, style: form.style || null, quantities: parseQuantities(form.quantities) };
    const saved = isNew ? await api.post('/costing/enquiries', body) : await api.put(`/costing/enquiries/${id}`, body);
    toast.success(isNew ? `${saved.enquiry_no} added to the Inbox` : `${saved.enquiry_no} saved`);
    setDirty(false);
    onChanged?.();
    if (isNew) onClose(); else { setE(saved); setForm(formOf(saved)); }
  };

  const field = (k, label, props = {}) => (
    <Field label={label}>
      <Input value={form[k]} onChange={ev => set(k, ev.target.value)} disabled={locked} {...props} />
    </Field>
  );

  return (
    <Modal open={!!id} onClose={onClose} wide
      title={isNew ? 'Add an enquiry by hand' : e ? `${e.enquiry_no} — ${e.product_name || 'enquiry'}` : 'Opening…'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {!locked && <Button onClick={save} disabled={!dirty || !(form.product_name.trim() || form.size_text.trim())}>{isNew ? 'Add to the Inbox' : 'Save details'}</Button>}
      </>}>
      {e && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-bold ${STAGE_TONE[e.stage]}`}>{statuses?.[e.stage] || e.stage}</span>
          {e.costing_no && <button type="button" className="font-bold text-brand-600 hover:underline" onClick={() => onOpenCosting?.(e)}>Costing {e.costing_no}{e.costing_complete ? '' : ' (not finished)'}</button>}
          {e.quotation_no && <span className="font-semibold text-slate-600">Quotation {e.quotation_no}</span>}
          {locked && <span className="text-amber-700">Prices are finalised — reopen them (Quotations tab) to change what was asked.</span>}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {field('customer_name', 'Customer')}
            {field('contact_name', 'Contact person')}
            {field('contact_email', 'Their e-mail', { type: 'email' })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('product_name', 'Product (as the customer names it)')}
            {field('size_text', 'Size L × W × H (mm)', { placeholder: 'e.g. 120 x 40 x 90' })}
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Pasting">
              <Select value={form.style} onChange={ev => set('style', ev.target.value)} disabled={locked} placeholder="Choose…">
                <option value="">Not set</option>
                {STYLE_OPTIONS.map(s => <option key={s} value={s}>{styleLabel(s)}</option>)}
              </Select>
            </Field>
            {field('board', 'Board', { placeholder: 'FBB, duplex…' })}
            {field('gsm', 'GSM', { inputMode: 'decimal' })}
            {field('colours', 'Colours', { inputMode: 'decimal' })}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {field('coating', 'Coating')}
            {field('quantities', 'Quantities asked', { placeholder: 'e.g. 10,000, 25k, 1 lakh' })}
            {field('target_price', 'Their target ₹ a carton', { inputMode: 'decimal' })}
          </div>
          <Field label="Other specifications (shown to the customer on the quotation)">
            <Textarea value={form.specs} onChange={ev => set('specs', ev.target.value)} disabled={locked} placeholder="Emboss, foil, window, inserts…" />
          </Field>
          <Field label="Notes (inside only — never on the quotation)">
            <Textarea value={form.notes} onChange={ev => set('notes', ev.target.value)} disabled={locked} />
          </Field>
          {e?.prices?.length > 0 && (
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-1 text-xs font-bold text-slate-600">Prices a carton</div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-500"><th>Quantity</th><th className="text-right">Costing proposes</th><th className="text-right">Final</th></tr></thead>
                <tbody>
                  {e.prices.map(p => (
                    <tr key={p.qty}><td>{qtyText(p.qty)}</td><td className="text-right">{rupees(p.proposed, 3)}</td>
                      <td className="text-right font-bold">{rupees(p.final)}{p.changed && <span className="ml-1 text-xs font-semibold text-amber-700" title={`Set against ${rupees(p.set_against, 3)}`}>costing changed</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="space-y-3">
          {e?.mail ? (
            <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
              <div className="mb-1 flex items-center gap-2 text-xs font-bold text-slate-600"><Mail size={14} />The customer's mail</div>
              <div className="text-sm font-bold text-[#1D1D1F]">{e.mail.subject || '(no subject)'}</div>
              <div className="text-xs text-slate-500">{[e.mail.from_name, e.mail.from_email].filter(Boolean).join(' · ')} · {dateText(e.mail.received_at)} · {e.mail.mailbox_email}</div>
              {e.mail.summary && <div className="mt-1 text-xs font-semibold text-brand-700">Claude read: {e.mail.summary}</div>}
              {e.mail.attachments?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {e.mail.attachments.map(a => <span key={a.name} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"><Paperclip size={11} />{a.name}</span>)}
                </div>
              )}
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-700">{e.mail.body_text || '(Claude kept no text for this mail)'}</pre>
              {e.mail.view_url && <a href={e.mail.view_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:underline">Open it in Gmail <ExternalLink size={12} /></a>}
              {e.siblings?.length > 0 && (
                <div className="mt-2 text-xs text-slate-600">Also in this mail: {e.siblings.map(s => `${s.enquiry_no} ${s.product_name || ''}`).join(' · ')}</div>
              )}
            </div>
          ) : !isNew && <div className="rounded-xl border border-dashed border-slate-300 p-3 text-xs text-slate-500">Typed in by hand — no mail. A reply goes to the e-mail address above as a new mail.</div>}
          {e?.events?.length > 0 && (
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="mb-1 text-xs font-bold text-slate-600">History</div>
              <ul className="space-y-0.5 text-xs text-slate-600">
                {e.events.map((ev, i) => (
                  <li key={i}><span className="font-semibold text-slate-800">{EVENT_TEXT[ev.action] || ev.action}</span> · {ev.by_name} · {dateText(ev.at)}
                    {ev.action === 'price' && ev.detail?.prices && <span> — {ev.detail.prices.map(p => `${qtyText(p.qty)} at ${rupees(p.final)}`).join(', ')}</span>}
                    {ev.detail?.reason && <span> — {ev.detail.reason}</span>}</li>
                ))}
              </ul>
            </div>
          )}
          {e && <div className="text-[11px] text-slate-400">Quantities: {quantitiesText(e.quantities)} · added by {e.created_by_name || 'Claude'} {dateText(e.created_at)}</div>}
        </div>
      </div>
    </Modal>
  );
}
