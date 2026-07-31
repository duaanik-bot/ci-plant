// The card, as the seven steps of the real process. Exactly ONE primary action
// is offered at a time — nextAction() decides which — so nobody has to work out
// which of six buttons applies to the card in front of them.
import { useEffect, useState } from 'react';
import { api, fmt, auth } from '../../api.js';
import {
  Button, Checkbox, ConfirmDialog, Field, Input, Modal, Select, Textarea,
} from '../../components/ui.jsx';
import {
  BadgeCheck, Send, Printer, PackageCheck, XCircle, Paperclip, Download, Trash2,
  History, AlertTriangle, CheckCircle2, Link2, Pencil,
} from 'lucide-react';
import { STATUS_META, scLabel, STEPS, stepIndex, nextAction, today } from './lifecycle.js';

const DOC_MAX_BYTES = 4 * 1024 * 1024;          // mirrors DOC_MAX_BYTES on the server
const mb = b => (b / 1024 / 1024).toFixed(1);
const DOC_TYPES = [
  { value: 'shade_card_pdf', label: 'Shade card PDF' },
  { value: 'signed_scan', label: 'Scanned signed copy' },
  { value: 'approval_email', label: 'Approval email' },
  { value: 'whatsapp', label: 'WhatsApp screenshot' },
  { value: 'artwork', label: 'High-res artwork' },
  { value: 'note', label: 'Note' },
  { value: 'other', label: 'Other' },
];
const canManage = () => ['admin', 'planner', 'qc'].includes(auth.user?.role);
const canMove = () => ['admin', 'planner', 'production', 'qc'].includes(auth.user?.role);

async function openDoc(doc) {
  const res = await fetch(`/api/shade-cards/docs/${doc.id}`, {
    headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function ShadeCardDrawer({ id, meta, onClose, onChange, toast }) {
  const [d, setD] = useState(null);
  const [action, setAction] = useState(null);      // { key, form }
  const [docForm, setDocForm] = useState({ file: null, doc_type: 'shade_card_pdf' });
  const [confirmDel, setConfirmDel] = useState(false);

  const reload = () => api.get(`/shade-cards/${id}`).then(setD).catch(() => toast.error('Could not load the card'));
  useEffect(() => { reload(); }, [id]);

  const run = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      setAction(null);
      await reload();
      await onChange();
    } catch (e) { toast.error(e.message || 'That did not work'); }
  };

  if (!d) return <Modal open onClose={onClose} title="Loading…" wide><div /></Modal>;

  const step = stepIndex(d);
  const act = nextAction(d);

  const openAction = key => {
    const base = { note: '' };
    if (key === 'sent') Object.assign(base, {
      sent_to_customer_date: today(), expected_approval_date: d.expected_approval_date || '' });
    if (key === 'approved') Object.assign(base, {
      approval_method: '', approval_received_date: today(),
      approval_received_by: auth.user?.name || '', customer_stamp: true, customer_signature: true,
      customer_contact_name: '', customer_designation: '', customer_company: d.customer_name || '' });
    if (key === 'issue') Object.assign(base, {
      issued_to: '', department: 'printing', job_card_id: '', remarks: '' });
    if (key === 'return') Object.assign(base, {
      returned_by: d.issued_to || '', received_by: auth.user?.name || '',
      condition: 'good', remarks: '' });
    if (key === 'rejected') Object.assign(base, { note: '' });
    setAction({ key, form: base });
  };
  const setAf = patch => setAction(a => ({ ...a, form: { ...a.form, ...patch } }));

  const submit = () => {
    const { key, form } = action;
    if (key === 'issue') return run(() => api.post(`/shade-cards/${d.id}/issue`, {
      ...form, job_card_id: form.job_card_id || undefined }), `${d.sc_number} issued to ${form.issued_to}`);
    if (key === 'return') return run(() => api.post(`/shade-cards/${d.id}/return`, form),
      `${d.sc_number} back in store`);
    return run(() => api.post(`/shade-cards/${d.id}/status`, {
      to: key, ...form,
      customer_stamp: form.customer_stamp ? 1 : 0,
      customer_signature: form.customer_signature ? 1 : 0,
    }), `${d.sc_number} → ${scLabel(key)}`);
  };

  const valid = !action ? false
    : action.key === 'approved' ? !!action.form.approval_method
        && (action.form.approval_method !== 'verbal' || !!action.form.note?.trim())
    : action.key === 'rejected' ? !!action.form.note?.trim()
    : action.key === 'issue' ? !!action.form.issued_to?.trim()
    : true;

  const Row = ({ label, value }) => value ? (
    <div className="flex justify-between gap-3 py-0.5 text-sm">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="text-right font-semibold text-slate-800">{value}</dd>
    </div>) : null;

  return (
    <>
      <Modal open onClose={onClose} wide title={`${d.sc_number} — ${d.title}`}
        footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <div className="space-y-4">
          {/* The seven steps. Where the card stands, at a glance. */}
          <ol className="flex flex-wrap items-center gap-1.5">
            {STEPS.map((s, i) => (
              <li key={s.key} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                i < step ? 'bg-emerald-50 text-emerald-700'
                  : i === step ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-400'}`}>
                <span className="tabular-nums opacity-60">{i + 1}</span>{s.label}
              </li>))}
          </ol>

          {/* One verdict line. Never both a green and a red badge at once. */}
          <div className={`rounded-2xl px-4 py-3 text-sm font-semibold ${
            d.printing_eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {d.printing_eligible
              ? <><CheckCircle2 size={14} className="mr-1.5 inline" />Cleared for printing</>
              : <><AlertTriangle size={14} className="mr-1.5 inline" />{d.printing_block_reason}</>}
            {d.with_printing && (
              <span className="mt-0.5 block text-xs font-medium opacity-80">
                Currently with {d.issued_to} · {fmt.title(d.department)} since {fmt.dt(d.issued_at)}
              </span>)}
          </div>

          {/* The code-mismatch warning: loud, but never a block. */}
          {!d.code_ok && (
            <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-extrabold text-red-700">
                <AlertTriangle size={15} /> This card does not match the product master
              </p>
              <ul className="mt-1 space-y-0.5">
                {d.code_mismatches.map((m, i) => (
                  <li key={i} className="text-xs font-semibold text-red-700/90">
                    {m.field}: card says <b>{m.card}</b>, master now says <b>{m.order}</b>
                  </li>))}
              </ul>
              <p className="mt-1.5 text-xs font-medium text-red-600/80">
                Printing can still start, but a supervisor has to acknowledge it and the
                acknowledgement is recorded against this card.
              </p>
            </div>)}

          {/* No date on record. Distinct from "expired": this card cannot be
              judged either way, so the 365-day rule never applies to it at all.
              It used to show as a blank dash and clear the gate in silence. */}
          {d.age_unknown && (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-extrabold text-amber-800">
                <AlertTriangle size={15} /> This card has no date on record
              </p>
              <p className="mt-1 text-xs font-semibold text-amber-800/90">
                Its age cannot be checked, so the {d.life_days || 365}-day life never applies
                to it. Colour standards fade whether or not anyone wrote the date down —
                find the physical card, read its date, and set it with Edit.
              </p>
              <p className="mt-1.5 text-xs font-medium text-amber-700/80">
                Printing can still start, but a supervisor has to acknowledge it and the
                acknowledgement is recorded against this card.
              </p>
            </div>)}

          {/* The one action. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {act && (canManage() || (act.key === 'return' && canMove())) && (
              <Button variant={act.variant} onClick={() => openAction(act.key)}>
                {act.key === 'sent' && <Send size={14} />}
                {act.key === 'approved' && <BadgeCheck size={14} />}
                {act.key === 'issue' && <Printer size={14} />}
                {act.key === 'return' && <PackageCheck size={14} />}
                {act.label}
              </Button>)}
            {d.status === 'sent' && canManage() && (
              <Button size="sm" variant="danger" onClick={() => openAction('rejected')}>
                <XCircle size={13} /> Customer Rejected
              </Button>)}
            <span className="ml-auto" />
            {canManage() && d.active === 1 && (
              <Button size="sm" variant="danger" onClick={() => setConfirmDel(true)}>
                <Trash2 size={13} /> Delete
              </Button>)}
          </div>

          {/* Inherited, read-only. Typed nowhere. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="ci-form-panel">
              <div className="ci-form-panel-title">From the sales order</div>
              <dl>
                <Row label="Sales order" value={d.po_number} />
                <Row label="Customer" value={d.customer_name} />
                <Row label="Product" value={d.product_name && `${d.product_name} · ${d.product_code || ''}`} />
                <Row label="Order quantity" value={d.order_qty != null && fmt.num(d.order_qty)} />
                <Row label="Artwork code" value={d.artwork_no} />
                <Row label="Output code" value={d.output_no} />
                <Row label="Board" value={[d.board_name, d.gsm && `${d.gsm} GSM`].filter(Boolean).join(' · ')} />
                <Row label="Print specs" value={[d.product_colour_system, d.product_colours && `${d.product_colours} colours`, d.coating].filter(Boolean).join(' · ')} />
              </dl>
            </section>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title">Approval</div>
              <dl>
                <Row label="Status" value={scLabel(d.status)} />
                <Row label="Sent on" value={d.sent_to_customer_date && fmt.date(d.sent_to_customer_date)} />
                <Row label="Expected by" value={d.expected_approval_date && fmt.date(d.expected_approval_date)} />
                <Row label="Approved on" value={d.approval_received_date && fmt.date(d.approval_received_date)} />
                <Row label="How" value={d.approval_method && fmt.title(d.approval_method)} />
                <Row label="Signed / stamped" value={d.status === 'approved'
                  ? `${d.customer_signature ? 'Signed' : 'Not signed'} · ${d.customer_stamp ? 'Stamped' : 'No stamp'}` : null} />
                <Row label="Approved by" value={d.customer_contact_name &&
                  `${d.customer_contact_name}${d.customer_designation ? `, ${d.customer_designation}` : ''}`} />
                <Row label="Age" value={d.age_unknown
                  ? 'No date on record — age cannot be checked'
                  : d.age_days != null && `${d.age_days} days of 365`} />
                <Row label="Remarks" value={d.approval_remarks} />
              </dl>
            </section>
          </div>

          {/* Custody history — every hand-off the card has been through. */}
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><Printer size={13} className="mr-1 inline" />Issue &amp; return history</div>
            {(d.issues || []).length === 0
              ? <p className="text-sm text-slate-400">Never issued — the card is in store.</p>
              : <div className="space-y-2">
                  {d.issues.map(i => (
                    <div key={i.id} className={`rounded-xl px-3 py-2 text-sm ${i.returned_at ? 'bg-slate-50' : 'bg-blue-50'}`}>
                      <p className="font-semibold text-slate-800">
                        {i.issued_to} <span className="text-slate-400">· {fmt.title(i.department)}</span>
                        {!i.returned_at && <span className="ml-2 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">OUT NOW</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        Issued {fmt.dt(i.issued_at)} by {i.issued_by || '—'}
                        {i.jc_number && <> · {i.jc_number}</>}{i.machine_name && <> · {i.machine_name}</>}
                      </p>
                      {i.returned_at && (
                        <p className="text-xs text-slate-500">
                          Returned {fmt.dt(i.returned_at)} by {i.returned_by || '—'}, received by {i.received_by || '—'}
                          {i.condition && <> · condition <b>{fmt.title(i.condition)}</b></>}
                          {i.remarks && <> · {i.remarks}</>}
                        </p>)}
                    </div>))}
                </div>}
          </section>

          {/* Documents */}
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><Paperclip size={13} className="mr-1 inline" />Documents</div>
            <div className="space-y-2">
              {(d.docs || []).map(doc => (
                <div key={doc.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <button className="block truncate font-semibold text-brand-600 hover:underline"
                      onClick={() => openDoc(doc)}>{doc.title || doc.file_name}</button>
                    <span className="text-xs text-slate-400">
                      {DOC_TYPES.find(t => t.value === doc.doc_type)?.label || fmt.title(doc.doc_type)}
                      {' · '}{doc.uploaded_by} · {fmt.dt(doc.created_at)}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openDoc(doc)}><Download size={13} /></Button>
                    {canManage() && (
                      <Button size="sm" variant="ghost"
                        onClick={() => run(() => api.del(`/shade-cards/docs/${doc.id}`), 'Document removed')}>
                        <Trash2 size={13} /></Button>)}
                  </span>
                </div>))}
              {canManage() && (
                <div className="grid gap-2 rounded-xl border border-dashed border-slate-200 p-3 sm:grid-cols-[1fr_auto_auto]">
                  {/* Checked on pick, not on send: a 9 MB scan over plant wifi
                      would otherwise upload for a minute and be refused at the
                      Vercel edge with an error nobody can read. */}
                  <input type="file" className="text-xs" onChange={e => {
                    const file = e.target.files?.[0] || null;
                    if (file && file.size > DOC_MAX_BYTES) {
                      toast.error(`${file.name} is ${mb(file.size)} MB — documents are capped at 4 MB. Compress the scan and try again.`);
                      e.target.value = '';
                      return setDocForm(f => ({ ...f, file: null }));
                    }
                    setDocForm(f => ({ ...f, file }));
                  }} />
                  <div className="w-44">
                    <Select value={docForm.doc_type} options={DOC_TYPES}
                      onChange={e => setDocForm(f => ({ ...f, doc_type: e.target.value }))} />
                  </div>
                  <Button size="sm" disabled={!docForm.file}
                    onClick={() => run(() => api.upload(`/shade-cards/${d.id}/docs`, docForm.file,
                      { doc_type: docForm.doc_type }), 'Document attached')
                      .then(() => setDocForm({ file: null, doc_type: 'shade_card_pdf' }))}>
                    <Paperclip size={13} /> Attach</Button>
                </div>)}
            </div>
          </section>

          {/* Audit trail */}
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><History size={13} className="mr-1 inline" />Audit trail</div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
              {(d.events || []).map(ev => (
                <div key={ev.id} className="flex items-baseline gap-2 border-l-2 border-slate-100 py-1 pl-3 text-xs">
                  <span className="shrink-0 font-semibold text-slate-700">
                    {fmt.title(ev.action.replace('tooling:', 'Hub: '))}</span>
                  {(ev.from_status || ev.to_status) && (
                    <span className="text-slate-500">{scLabel(ev.from_status)} → {scLabel(ev.to_status)}</span>)}
                  {ev.note && <span className="truncate text-slate-400">{ev.note}</span>}
                  <span className="ml-auto shrink-0 text-slate-300">{ev.user_name} · {fmt.dt(ev.at)}</span>
                </div>))}
            </div>
          </section>
        </div>
      </Modal>

      {/* The action sheet. One per step, only the fields that step needs. */}
      <Modal open={!!action} onClose={() => setAction(null)}
        title={action ? `${nextActionTitle(action.key)} — ${d.sc_number}` : ''}
        footer={action && <>
          <Button variant="secondary" onClick={() => setAction(null)}>Cancel</Button>
          <Button variant={action.key === 'rejected' ? 'danger' : 'primary'}
            disabled={!valid} onClick={submit}>Confirm</Button>
        </>}>
        {action?.key === 'sent' && (
          <div className="space-y-3">
            <Field label="Sent on" required>
              <Input type="date" value={action.form.sent_to_customer_date}
                onChange={e => setAf({ sent_to_customer_date: e.target.value })} />
            </Field>
            <Field label="Expected approval by" hint="Drives the Overdue tile and the overdue alarm">
              <Input type="date" value={action.form.expected_approval_date}
                onChange={e => setAf({ expected_approval_date: e.target.value })} />
            </Field>
            {d.status === 'approved' && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                Sending this card again clears its current approval — the customer has to
                approve it afresh, and the 365-day age clock restarts when they do.
              </p>)}
          </div>)}

        {action?.key === 'approved' && meta && (
          <div className="space-y-3">
            <Field label="How did the approval arrive?" required>
              <Select value={action.form.approval_method}
                options={[{ value: '', label: 'Select…' },
                  ...meta.approval_methods.map(m => ({ value: m.key, label: m.label }))]}
                onChange={e => setAf({ approval_method: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Received on">
                <Input type="date" value={action.form.approval_received_date}
                  onChange={e => setAf({ approval_received_date: e.target.value })} />
              </Field>
              <Field label="Received by (our side)">
                <Input value={action.form.approval_received_by}
                  onChange={e => setAf({ approval_received_by: e.target.value })} />
              </Field>
            </div>
            <div className="flex gap-5">
              <Checkbox label="Customer signed it" checked={!!action.form.customer_signature}
                onChange={e => setAf({ customer_signature: e.target.checked })} />
              <Checkbox label="Customer stamped it" checked={!!action.form.customer_stamp}
                onChange={e => setAf({ customer_stamp: e.target.checked })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Who approved it">
                <Input value={action.form.customer_contact_name}
                  onChange={e => setAf({ customer_contact_name: e.target.value })} />
              </Field>
              <Field label="Their designation">
                <Input value={action.form.customer_designation}
                  onChange={e => setAf({ customer_designation: e.target.value })} />
              </Field>
            </div>
            <Field label={action.form.approval_method === 'verbal' ? 'Remarks (mandatory for a verbal approval)' : 'Remarks'}
              required={action.form.approval_method === 'verbal'}>
              <Textarea value={action.form.note} onChange={e => setAf({ note: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              The card's 365-day life will run from the date you record here.
            </p>
          </div>)}

        {action?.key === 'rejected' && (
          <Field label="What did the customer object to?" required>
            <Textarea value={action.form.note} onChange={e => setAf({ note: e.target.value })} />
          </Field>)}

        {action?.key === 'issue' && meta && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Issued to" required>
                <Input value={action.form.issued_to} placeholder="Name of the person taking it"
                  onChange={e => setAf({ issued_to: e.target.value })} />
              </Field>
              <Field label="Department" required>
                <Select value={action.form.department}
                  options={meta.departments.map(x => ({ value: x.key, label: x.label }))}
                  onChange={e => setAf({ department: e.target.value })} />
              </Field>
            </div>
            <Field label="Remarks">
              <Input value={action.form.remarks} onChange={e => setAf({ remarks: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">
              Issued by {auth.user?.name} at the moment you confirm. If the card is attached
              to a print job it comes back automatically when that job finishes printing.
            </p>
          </div>)}

        {action?.key === 'return' && meta && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Returned by">
                <Input value={action.form.returned_by} onChange={e => setAf({ returned_by: e.target.value })} />
              </Field>
              <Field label="Received by">
                <Input value={action.form.received_by} onChange={e => setAf({ received_by: e.target.value })} />
              </Field>
            </div>
            <Field label="Condition" required>
              <Select value={action.form.condition}
                options={meta.return_conditions.map(x => ({ value: x.key, label: x.label }))}
                onChange={e => setAf({ condition: e.target.value })} />
            </Field>
            <Field label="Remarks">
              <Textarea value={action.form.remarks} onChange={e => setAf({ remarks: e.target.value })} />
            </Field>
          </div>)}
      </Modal>

      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} danger
        title={`Delete ${d.sc_number}?`}
        message="The card leaves the register but nothing is destroyed — its history and audit trail are kept."
        confirmLabel="Delete"
        onConfirm={() => run(() => api.del(`/shade-cards/${d.id}`), 'Shade card deleted')
          .then(() => { setConfirmDel(false); onClose(); })} />
    </>
  );
}

const nextActionTitle = key => ({
  sent: 'Dispatch to customer', approved: 'Record the customer approval',
  rejected: 'Record the rejection', issue: 'Issue to a department',
  return: 'Record the return',
}[key] || 'Update');
