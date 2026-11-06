// Costing inside the Enquiry desk (owner, 5 Nov 2026: "I should be able to do the costings in the inquiry desk
// itself"). The enquiry on top — what the customer asked, and their mail — and its costing below, on the same
// screens as Costing → New costing and Bulk costing, opened in place:
//   • one at a time: "Cost it" on a row, or on several ticked rows, with Previous / Next and "Save & next";
//   • together: one bulk costing of the ticked rows.
// The person controls which costing an enquiry carries: revise the one it has, start a fresh one, or start from
// an earlier costing of the same size or product (copied — the earlier one is not changed). Saving links the
// costing and moves the enquiry on (Costing, then Final price once complete); the desk's bar offers to undo it.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, ExternalLink, FilePlus2, Mail, Paperclip, PencilLine, Search } from 'lucide-react';
import { api } from '../../api.js';
import { Button, DataTable, Input, Modal } from '../../components/ui.jsx';
import { styleLabel } from '../../lib/costing.js';
import { STAGE_TONE, dateText, quantitiesText, rupees, whereText } from '../../lib/enquiryUi.js';
import SingleCosting from './SingleCosting.jsx';
import { BatchEditor } from './BulkCosting.jsx';

// Which costing the form holds: the enquiry's own (revise it), a fresh one from what was asked, or a copy of
// an earlier costing. `n` remounts the form when the same choice is made again.
const defaultHow = (e, n = 0) => (e?.costing_live && e?.costing_id ? { kind: 'linked', costingId: e.costing_id, n } : { kind: 'fresh', n });

export default function DeskCosting({ boot, customers, work, statuses, onClose, onMoved, onEditEnquiry, reloadSignal = 0 }) {
  if (work.mode === 'together') {
    return <Together boot={boot} customers={customers} work={work} onClose={onClose} onMoved={onMoved} />;
  }
  return <OneByOne boot={boot} customers={customers} work={work} statuses={statuses} onClose={onClose} onMoved={onMoved}
    onEditEnquiry={onEditEnquiry} reloadSignal={reloadSignal} />;
}

function Together({ boot, customers, work, onClose, onMoved }) {
  const [batchId, setBatchId] = useState(work.batchId || null);
  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">
        Costing {work.ids.length} enquiries together. Each row carries its enquiry number; saving the batch links every row to its enquiry and
        moves it on — to Final price once the row is complete. A row you take out goes back to wait in Costing.
      </p>
      <BatchEditor embedded backLabel="← Back to the desk" boot={boot} customers={customers}
        batchId={batchId} seedIds={batchId ? [] : work.ids}
        onClose={onClose} onOpened={setBatchId} onSaved={b => onMoved({ kind: 'batch', batch: b })} />
    </div>
  );
}

function OneByOne({ boot, customers, work, statuses, onClose, onMoved, onEditEnquiry, reloadSignal }) {
  const [at, setAt] = useState(work.at || 0);
  const [e, setE] = useState(null);
  const [how, setHow] = useState({ kind: 'fresh', n: 0 });
  const [mail, setMail] = useState(false);
  const [picking, setPicking] = useState(false);
  const id = work.ids[at];
  const total = work.ids.length;
  // A read that comes back after the person moved to another enquiry is dropped.
  const current = useRef(id);
  current.current = id;

  const load = () => api.get(`/costing/enquiries/${id}`);
  const keep = x => {
    if (!x || x.id !== current.current) return x;
    setE(x);
    // The costing being revised is no longer this enquiry's (undone, replaced elsewhere): the form follows.
    setHow(h => (h.kind === 'linked' && (!x.costing_live || x.costing_id !== h.costingId) ? defaultHow(x, h.n + 1) : h));
    return x;
  };
  // A new enquiry: its own costing if it has one, else a fresh one from what was asked.
  useEffect(() => {
    let live = true;
    setE(null);
    load().then(x => { if (live) { setE(x); setHow(defaultHow(x)); setMail(false); } }).catch(() => live && onClose());
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // The same enquiry read again (after a save, or its details were edited) keeps the form as it is.
  useEffect(() => {
    if (!reloadSignal) return undefined;
    let live = true;
    load().then(x => live && keep(x)).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const choose = next => setHow(h => ({ ...(next.kind === 'linked' ? { kind: 'linked', costingId: e.costing_id } : next), n: h.n + 1 }));
  const saved = async c => {
    onMoved({ kind: 'costing', costing: c, enquiry: e });
    const x = keep(await load().catch(() => null));
    // A fresh or copied costing, once saved, is the enquiry's own: the form goes on revising it.
    if (x && x.id === current.current && how.kind !== 'linked' && x.costing_id === c.id) setHow(h => ({ kind: 'linked', costingId: c.id, n: h.n + 1 }));
  };
  const last = at >= total - 1;
  const saveNext = last ? { label: 'Save & back to the desk', onNext: onClose } : { label: 'Save & next', onNext: () => setAt(i => Math.min(i + 1, total - 1)) };

  if (!e) return <div className="p-8 text-sm text-slate-400">Opening the enquiry…</div>;
  // A costing is only ever opened by its number; without one the form starts fresh from the enquiry.
  const formProps = how.kind === 'linked' && how.costingId ? { openId: String(how.costingId) }
    : how.kind === 'from' && how.costingId ? { fromId: String(how.costingId) } : {};

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onClose} className="text-sm font-semibold text-brand-600 hover:underline">← Back to the desk</button>
        <div className="mx-2 h-4 w-px bg-slate-300" />
        <span className="text-sm font-bold text-[#1D1D1F]">{e.enquiry_no}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${STAGE_TONE[e.stage]}`}>{statuses?.[e.stage] || e.stage}</span>
        <span className="text-xs text-slate-500">on the desk: {whereText(e.stage)}</span>
        {total > 1 && (
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="secondary" disabled={at === 0} onClick={() => setAt(i => Math.max(i - 1, 0))}><ChevronLeft size={14} className="inline" /> Previous</Button>
            <span className="px-1 text-xs font-semibold text-slate-600">{at + 1} of {total}</span>
            <Button size="sm" variant="secondary" disabled={last} onClick={() => setAt(i => Math.min(i + 1, total - 1))}>Next <ChevronRight size={14} className="inline" /></Button>
          </div>
        )}
      </div>

      <EnquiryCard e={e} mail={mail} onMail={() => setMail(m => !m)} onEdit={() => onEditEnquiry(e.id)} />

      <div className="glass mb-3 flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2 text-xs">
        <CostingLine e={e} how={how} />
        <div className="ml-auto flex flex-wrap gap-1.5">
          {how.kind !== 'linked' && e.costing_live && (
            <Button size="sm" variant="secondary" onClick={() => choose({ kind: 'linked' })}><PencilLine size={13} className="mr-1 inline" />Back to {e.costing_no}</Button>
          )}
          {(how.kind !== 'fresh' || e.costing_live) && (
            <Button size="sm" variant="secondary" onClick={() => choose({ kind: 'fresh' })}><FilePlus2 size={13} className="mr-1 inline" />Start a fresh costing</Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setPicking(true)}><Copy size={13} className="mr-1 inline" />Start from an earlier costing</Button>
        </div>
      </div>
      <StageNote e={e} />

      <SingleCosting key={`${e.id}|${how.kind}|${how.costingId || ''}|${how.n}`} embedded boot={boot} customers={customers}
        enquiry={e} {...formProps} saveNext={saveNext} onSaved={saved} />

      <EarlierPicker open={picking} e={e} onClose={() => setPicking(false)}
        onPick={c => { setPicking(false); choose({ kind: 'from', costingId: c.id, costingNo: c.costing_no }); }} />
    </div>
  );
}

// What the customer asked, beside the costing: the person can check one against the other without leaving.
function EnquiryCard({ e, mail, onMail, onEdit }) {
  const facts = [
    ['Customer', e.customer_name], ['Product', e.product_name], ['Size (mm)', e.size_text], ['Pasting', e.style ? styleLabel(e.style) : null],
    ['Board', e.board], ['GSM', e.gsm], ['Colours', e.colours], ['Coating', e.coating], ['Quantities asked', quantitiesText(e.quantities)],
    ['Their target', e.target_price ? `${rupees(e.target_price, 3)} a carton` : null],
  ];
  return (
    <section className="glass mb-3 rounded-2xl p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-sm font-bold text-[#1D1D1F]">What the customer asked</div>
        {e.mail_subject && <span className="truncate text-xs text-slate-500">“{e.mail_subject}” · {dateText(e.mail_received_at)}</span>}
        <div className="ml-auto flex gap-1.5">
          {e.mail_id && <Button size="sm" variant="secondary" onClick={onMail}><Mail size={13} className="mr-1 inline" />{mail ? 'Hide the mail' : 'Show the mail'}</Button>}
          <Button size="sm" variant="secondary" onClick={onEdit}><PencilLine size={13} className="mr-1 inline" />Edit what was asked</Button>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{k}</dt>
            <dd className={`truncate font-semibold ${v == null || v === '' || v === '—' ? 'text-slate-300' : 'text-[#1D1D1F]'}`} title={v ? String(v) : ''}>{v == null || v === '' ? 'not given' : v}</dd>
          </div>
        ))}
      </dl>
      {(e.specs || e.notes) && (
        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          {e.specs && <div><span className="font-semibold text-slate-500">Other specifications: </span>{e.specs}</div>}
          {e.notes && <div><span className="font-semibold text-slate-500">Notes (inside only): </span>{e.notes}</div>}
        </div>
      )}
      {mail && e.mail && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white/70 p-3">
          <div className="text-xs text-slate-500">{[e.mail.from_name, e.mail.from_email].filter(Boolean).join(' · ')} · {dateText(e.mail.received_at)}</div>
          {e.mail.summary && <div className="mt-1 text-xs font-semibold text-brand-700">Claude read: {e.mail.summary}</div>}
          {e.mail.attachments?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {e.mail.attachments.map(a => <span key={a.name} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"><Paperclip size={11} />{a.name}</span>)}
            </div>
          )}
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-700">{e.mail.body_text || '(Claude kept no text for this mail)'}</pre>
          {e.mail.view_url && <a href={e.mail.view_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:underline">Open it in Gmail <ExternalLink size={12} /></a>}
        </div>
      )}
    </section>
  );
}

// Which costing the form below holds, and what saving it does to the enquiry.
function CostingLine({ e, how }) {
  if (how.kind === 'linked') {
    return (
      <span>
        <b>Revising {e.costing_no}</b>{e.costing_version ? ` · revision ${e.costing_version}` : ''}
        {e.costing_approved_by && e.costing_status === 'approved' ? ` · approved by ${e.costing_approved_by}` : ' · draft, not approved'}
        {e.batch_no ? ` · in bulk costing ${e.batch_no}` : ''}
      </span>
    );
  }
  if (how.kind === 'from') {
    return <span><b>Started from {how.costingNo}</b> — saving makes a new costing for {e.enquiry_no}{e.costing_live ? ` in place of ${e.costing_no} (kept in Saved costings)` : ''}; {how.costingNo} is not changed.</span>;
  }
  return e.costing_live
    ? <span><b>A fresh costing</b> — saving it puts it on {e.enquiry_no} in place of {e.costing_no}, which stays in Saved costings.</span>
    : <span><b>No costing yet</b> — the form starts from what the customer asked; the costing's own auto-fill does the rest.</span>;
}

function StageNote({ e }) {
  const text = e.costing_hidden ? `Its costing ${e.costing_no} is hidden in Saved costings, so the enquiry waits in Costing — cost it again, or show that costing again.`
    : e.stage === 'price_pending' ? 'Final prices are saved for this enquiry. If this costing changes, they are marked "costing changed" in Final price.'
      : e.stage === 'quote_ready' ? 'Its prices are finalised. A change here is kept on the costing but does not reach the quotation — send the enquiry back to Final price first.'
        : e.stage === 'sent' ? 'Its quotation is sent. A change here is kept on the costing only.'
          : e.stage === 'dropped' ? 'This enquiry is dropped — bring it back first, or saving does not move it.' : null;
  if (!text) return null;
  return <div className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">{text}</div>;
}

// Earlier costings to start from: the same size first (the search starts at the enquiry's size), any product.
function EarlierPicker({ open, e, onClose, onPick }) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => { if (open) setSearch(e?.size_key || e?.size_text || e?.product_name || ''); }, [open, e?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const t = setTimeout(() => {
      setRows(null);
      api.get(`/costing/costings?limit=40${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`)
        .then(r => live && setRows((r.rows || []).filter(c => c.id !== e?.costing_id))).catch(() => live && setRows([]));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, search, e?.costing_id]);
  const columns = [
    { key: 'costing_no', label: 'Costing', render: c => <div><div className="font-bold text-brand-600">{c.costing_no}</div>{c.source === 'sheet' && <div className="text-[10px] text-slate-500">old cost sheet</div>}</div> },
    { key: 'product_name', label: 'Product', render: c => <div><div className="font-semibold">{c.product_name}</div><div className="text-[11px] text-slate-500">{[c.customer_name, c.enquiry_no && `for ${c.enquiry_no}`].filter(Boolean).join(' · ')}</div></div> },
    { key: 'size_text', label: 'Size', render: c => c.size_key || c.size_text || '—' },
    { key: 'qty', label: 'Qty', align: 'right', render: c => (c.qty ? Number(c.qty).toLocaleString('en-IN') : '—') },
    { key: 'cost_per_unit', label: 'Cost a carton', align: 'right', render: c => rupees(c.cost_per_unit, 3) },
    { key: 'costed_on', label: 'Costed on', render: c => c.costed_on || '—' },
  ];
  return (
    <Modal open={open} onClose={onClose} wide title={`Start ${e?.enquiry_no || ''} from an earlier costing`}
      footer={<Button variant="secondary" onClick={onClose}>Cancel</Button>}>
      <p className="mb-2 text-xs text-slate-500">Pick a costing to copy: its size, layout and rates fill the form; the customer, product and quantity stay this enquiry's. The earlier costing is not changed.</p>
      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <Input className="!pl-8" value={search} onChange={ev => setSearch(ev.target.value)} placeholder="Size (120x40x90), product, customer or costing number" />
      </div>
      <DataTable rows={rows || []} columns={columns} onRowClick={onPick} serialNumber={false} defaultSort={{ key: 'costed_on', dir: 'desc' }}
        empty={rows ? 'No costing matches — try the product name, or clear the search.' : 'Looking…'} />
    </Modal>
  );
}
