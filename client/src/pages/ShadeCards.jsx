// Shade Card Management — the quality module. A shade card is a customer
// approval document, not a tooling asset: this register is the single source of
// truth for identity, the approval lifecycle (internal QC + customer), revision
// history, supporting documents, Sales-Order links and the physical dock loop
// (Triage → Vault ⇄ On Press). Planning, Job Cards and Production read live
// from here.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import {
  Button, Field, Input, Textarea, Select, Checkbox, Modal, ConfirmDialog,
  KpiCard, PageHeader, SearchInput, rowMatches, searchText, DataTable, Tabs, SubTabs, useToast,
} from '../components/ui.jsx';
import {
  Plus, SwatchBook, Send, Stamp, BadgeCheck, ShieldCheck, AlertTriangle, History,
  Paperclip, Link2, Download, Trash2, RotateCcw, Printer, Archive, FileClock,
  CheckCircle2, Clock4, XCircle, Pencil, ArrowRight, Building2, Vault,
} from 'lucide-react';

const canManage = () => ['admin', 'planner', 'qc'].includes(auth.user?.role);
const canMove = () => ['admin', 'planner', 'production', 'qc'].includes(auth.user?.role);

// ── Lifecycle presentation ────────────────────────────────────────────────────
const STATUS_META = {
  draft:              { label: 'Draft',              cls: 'bg-slate-100 text-slate-600' },
  internal_review:    { label: 'Internal Review',    cls: 'bg-amber-50 text-amber-700' },
  internal_approved:  { label: 'Internal Approved',  cls: 'bg-blue-50 text-blue-700' },
  sent_to_customer:   { label: 'Sent to Customer',   cls: 'bg-violet-50 text-violet-700' },
  customer_reviewing: { label: 'Customer Reviewing', cls: 'bg-violet-50 text-violet-700' },
  revision_requested: { label: 'Revision Requested', cls: 'bg-orange-50 text-orange-700' },
  revised:            { label: 'Revised',            cls: 'bg-amber-50 text-amber-700' },
  customer_approved:  { label: 'Customer Approved',  cls: 'bg-emerald-50 text-emerald-700' },
  rejected:           { label: 'Rejected',           cls: 'bg-red-50 text-red-700' },
  expired:            { label: 'Expired',            cls: 'bg-red-50 text-red-700' },
  superseded:         { label: 'Superseded',         cls: 'bg-[#1D1D1F] text-white' },
  archived:           { label: 'Archived',           cls: 'bg-slate-100 text-slate-500' },
};
const scLabel = s => STATUS_META[s]?.label ?? fmt.title(s || '—');

function ScStatus({ status }) {
  const m = STATUS_META[status] || { label: fmt.title(status || '—'), cls: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{m.label}
    </span>
  );
}

const DOCK_META = {
  triage:   { label: 'Triage',   cls: 'bg-slate-100 text-slate-600' },
  vault:    { label: 'Vault',    cls: 'bg-teal-50 text-teal-700' },
  on_press: { label: 'On Press', cls: 'bg-blue-50 text-blue-700' },
};

// Client mirror of the pure transition map — drives which action buttons show.
const NEXT = {
  draft:              ['internal_review'],
  internal_review:    ['internal_approved', 'draft'],
  internal_approved:  ['sent_to_customer'],
  sent_to_customer:   ['customer_reviewing', 'customer_approved', 'revision_requested', 'rejected'],
  customer_reviewing: ['customer_approved', 'revision_requested', 'rejected'],
  revision_requested: [],
  revised:            ['internal_review', 'sent_to_customer'],
  customer_approved:  ['revision_requested'],
  rejected:           [],
  expired:            [],
  superseded:         [],
  archived:           [],
};

const DOC_TYPES = [
  { value: 'shade_card_pdf',   label: 'Shade card PDF' },
  { value: 'artwork',          label: 'High-res artwork' },
  { value: 'signed_scan',      label: 'Scanned signed copy' },
  { value: 'approval_email',   label: 'Approval email' },
  { value: 'whatsapp',         label: 'WhatsApp screenshot' },
  { value: 'digital_approval', label: 'Digital approval file' },
  { value: 'revision_doc',     label: 'Revision document' },
  { value: 'note',             label: 'Note' },
  { value: 'other',            label: 'Other' },
];

const APPROVAL_CLASS_LABEL = {
  internal_only: 'Only internally approved',
  customer_no_stamp_digital: 'Customer approved digitally (no stamp)',
  customer_no_stamp_physical: 'Customer approved physically (no stamp)',
  customer_no_stamp_other: 'Customer approved (no stamp)',
  customer_stamped_digital: 'Customer approved digitally, stamped',
  customer_stamped_physical: 'Customer approved physically, stamped',
  customer_stamped_other: 'Customer approved with stamp',
  none: 'Not approved yet',
};

// Authenticated document download — plain <a href> would drop the bearer token.
async function openDoc(doc) {
  const res = await fetch(`/api/shade-cards/docs/${doc.id}`, {
    headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const today = () => new Date().toISOString().slice(0, 10);
const emptyForm = {
  title: '', product_id: '', customer_id: '', print_process: '', colour_system: '',
  num_colours: '', artwork_no: '', artwork_rev: '', print_reference: '', colour_details: '',
  approval_requirement: '', expected_approval_date: '', creation_date: today(), location: '', remarks: '',
};

export default function ShadeCards() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [meta, setMeta] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [reports, setReports] = useState(null);
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stations, setStations] = useState({ machines: [], jobs: [] });
  const [view, setView] = useState('register');
  const [tab, setTab] = useState('live');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(null);      // form draft | null
  const [editing, setEditing] = useState(null);        // form draft + id | null
  const [detail, setDetail] = useState(null);          // full card | null
  const [action, setAction] = useState(null);          // { type, card, form } | null
  const [confirmDel, setConfirmDel] = useState(null);
  const [docForm, setDocForm] = useState({ file: null, doc_type: 'shade_card_pdf', note: '' });
  const [linkOrder, setLinkOrder] = useState('');
  const [dock, setDock] = useState({ machine_id: '', operator: '', job_card_id: '' });

  // Surface a load failure instead of swallowing it — a dead/unreachable backend
  // must NOT read as "no shade cards". A network reject fires no central toast
  // (unlike a 500), so this page owns showing the outage. Last-good rows are kept
  // on a transient blip; the 20s poll clears the flag on the next success.
  const load = () => Promise.all([
    api.get('/shade-cards?all=1').then(setRows),
    api.get('/shade-cards/alerts').then(setAlerts),
  ]).then(() => setLoadError(false)).catch(() => setLoadError(true));
  useEffect(() => {
    load();
    api.get('/shade-cards/meta').then(setMeta).catch(() => {});
    api.get('/products').then(setProducts).catch(() => {});
    api.get('/customers').then(setCustomers).catch(() => {});
    api.get('/orders').then(setOrders).catch(() => {});
    api.get('/shade-cards/print-stations').then(setStations).catch(() => {});
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (view === 'reports') api.get('/shade-cards/reports').then(setReports).catch(() => {});
  }, [view, rows]);

  const openDetail = async id => setDetail(await api.get(`/shade-cards/${id}`));
  const refreshDetail = async id => { await load(); if (id) await openDetail(id); };
  const act = async (fn, msg, keepDetail = true) => {
    const id = detail?.id;
    await fn();
    if (msg) toast.success(msg);
    setAction(null);
    await (keepDetail && id ? refreshDetail(id) : load());
  };

  // ── Buckets & KPIs ───────────────────────────────────────────────────────────
  const active = rows.filter(r => r.active);
  const buckets = useMemo(() => ({
    live: active.filter(r => !['archived', 'superseded'].includes(r.status)),
    pending_internal: active.filter(r => ['draft', 'internal_review', 'revised'].includes(r.status)),
    with_customer: active.filter(r => ['sent_to_customer', 'customer_reviewing'].includes(r.status)),
    approved: active.filter(r => r.status === 'customer_approved' && !r.expired_by_age),
    attention: active.filter(r => ['rejected', 'revision_requested', 'expired'].includes(r.status) || r.expired_by_age
      || (['sent_to_customer', 'customer_reviewing'].includes(r.status) && r.expected_approval_date && r.expected_approval_date < today())),
    archived: rows.filter(r => !r.active || ['archived', 'superseded'].includes(r.status)),
  }), [rows]);

  const filtered = useMemo(
    () => (buckets[tab] || []).filter(r => rowMatches(r, q,
      `${(r.orders || []).map(o => o.po_number).join(' ')} ${scLabel(r.status)}`)),
    [buckets, tab, q]);

  const overdueCount = buckets.with_customer.filter(r => r.expected_approval_date && r.expected_approval_date < today()).length;
  const critical = alerts.filter(a => a.severity === 'critical');

  // ── Create / edit form helpers ───────────────────────────────────────────────
  const productById = id => products.find(p => String(p.id) === String(id));
  const onPickProduct = (draft, setDraft) => e => {
    const p = productById(e.target.value);
    setDraft({
      ...draft, product_id: e.target.value,
      customer_id: p ? String(p.customer_id) : draft.customer_id,
      title: draft.title || (p ? `${p.name} shade card` : ''),
      colour_system: draft.colour_system || p?.colour_type || '',
      num_colours: draft.num_colours || (p?.colors ?? ''),
      artwork_no: draft.artwork_no || p?.party_artwork_code || '',
    });
  };

  const FormBody = ({ draft, setDraft }) => (
    <div className="space-y-3">
      <section className="ci-form-panel">
        <div className="ci-form-panel-title">Identity</div>
        <div className="ci-form-grid">
          <Field label="Product" required>
            <Select value={draft.product_id} onChange={onPickProduct(draft, setDraft)}>
              <option value="">Select product…</option>
              {products.filter(p => p.active).map(p => (
                <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name} · {p.code}</option>))}
            </Select>
          </Field>
          <Field label="Customer">
            <Select value={draft.customer_id} onChange={e => setDraft({ ...draft, customer_id: e.target.value })}>
              <option value="">Select customer…</option>
              {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Shade card name" required className="sm:col-span-2">
            <Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
          </Field>
        </div>
      </section>
      <section className="ci-form-panel">
        <div className="ci-form-panel-title">Colour & print</div>
        <div className="ci-form-grid">
          <Field label="Colour system">
            <Select value={draft.colour_system} onChange={e => setDraft({ ...draft, colour_system: e.target.value })}>
              <option value="">Select…</option>
              <option value="CMYK">CMYK</option>
              <option value="Pantone">Pantone</option>
              <option value="CMYK + Pantone">Hybrid (CMYK + Pantone)</option>
            </Select>
          </Field>
          <Field label="Number of colours">
            <Input type="number" min="1" value={draft.num_colours}
              onChange={e => setDraft({ ...draft, num_colours: e.target.value })} />
          </Field>
          <Field label="Print process">
            <Select value={draft.print_process} onChange={e => setDraft({ ...draft, print_process: e.target.value })}>
              <option value="">Select…</option>
              {['Offset', 'UV Offset', 'Digital', 'Flexo', 'Gravure', 'Screen'].map(x =>
                <option key={x} value={x}>{x}</option>)}
            </Select>
          </Field>
          <Field label="Print reference" hint="Pantone refs / press notes carried onto the Job Card">
            <Input value={draft.print_reference} onChange={e => setDraft({ ...draft, print_reference: e.target.value })} />
          </Field>
          <Field label="Colour details" className="sm:col-span-2">
            <Textarea value={draft.colour_details} onChange={e => setDraft({ ...draft, colour_details: e.target.value })} />
          </Field>
        </div>
      </section>
      <section className="ci-form-panel">
        <div className="ci-form-panel-title">Artwork & control</div>
        <div className="ci-form-grid">
          <Field label="Artwork number">
            <Input value={draft.artwork_no} onChange={e => setDraft({ ...draft, artwork_no: e.target.value })} />
          </Field>
          <Field label="Artwork revision">
            <Input value={draft.artwork_rev} onChange={e => setDraft({ ...draft, artwork_rev: e.target.value })} />
          </Field>
          <Field label="Approval requirement" hint="Customer = printing blocked until the customer approves">
            <Select value={draft.approval_requirement} onChange={e => setDraft({ ...draft, approval_requirement: e.target.value })}>
              <option value="">Default (product / customer setting)</option>
              <option value="customer">Customer approval mandatory</option>
              <option value="internal">Internal approval sufficient</option>
            </Select>
          </Field>
          <Field label="Expected approval date">
            <Input type="date" value={draft.expected_approval_date}
              onChange={e => setDraft({ ...draft, expected_approval_date: e.target.value })} />
          </Field>
          <Field label="Card made on" hint="Drives the 365-day expiry engine">
            <Input type="date" value={draft.creation_date}
              onChange={e => setDraft({ ...draft, creation_date: e.target.value })} />
          </Field>
          <Field label="Physical location">
            <Input value={draft.location} placeholder="QC Cabinet…"
              onChange={e => setDraft({ ...draft, location: e.target.value })} />
          </Field>
          <Field label="Remarks" className="sm:col-span-2">
            <Textarea value={draft.remarks} onChange={e => setDraft({ ...draft, remarks: e.target.value })} />
          </Field>
        </div>
      </section>
    </div>
  );

  // ── Workflow action modal ────────────────────────────────────────────────────
  const openAction = (type, card) => {
    const base = { note: '' };
    if (type === 'sent_to_customer') Object.assign(base, {
      sent_to_customer_date: today(), expected_approval_date: card.expected_approval_date || '' });
    if (type === 'internal_approved') Object.assign(base, {
      internal_qc_stamp: true, internal_signatory: auth.user?.name || '', internal_approval_date: today() });
    if (type === 'customer_approved') Object.assign(base, {
      approval_method: '', approval_received_date: today(), approval_received_by: auth.user?.name || '',
      customer_stamp: false, customer_signature: false,
      customer_contact_name: '', customer_designation: '', customer_company: card.customer_name || '' });
    if (type === 'revise') Object.assign(base, { reason: '', requested_by: '' });
    setAction({ type, card, form: base });
  };
  const setAf = patch => setAction(a => ({ ...a, form: { ...a.form, ...patch } }));

  const runAction = () => {
    const { type, card, form } = action;
    if (type === 'revise') {
      return act(() => api.post(`/shade-cards/${card.id}/revise`, form),
        `${card.sc_number} — new revision issued`);
    }
    return act(() => api.post(`/shade-cards/${card.id}/status`, { to: type, ...form,
      internal_qc_stamp: form.internal_qc_stamp ? 1 : 0,
      customer_stamp: form.customer_stamp ? 1 : 0,
      customer_signature: form.customer_signature ? 1 : 0,
    }), `${card.sc_number} → ${scLabel(type)}`);
  };

  const actionValid = !action ? false
    : action.type === 'customer_approved' ? !!action.form.approval_method
      && (action.form.approval_method !== 'verbal' || !!action.form.note?.trim())
    : action.type === 'revise' ? !!action.form.reason?.trim()
    : true;

  // ── Table columns (register + full audit-grade export) ───────────────────────
  const columns = [
    { key: 'sc_number', label: 'Shade Card No', render: r => (
        <span className="font-semibold text-slate-900">{r.sc_number}
          {r.revision_no > 0 && <span className="ml-1.5 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">Rev {r.revision_no}</span>}
        </span>), searchValue: r => `${r.sc_number} rev ${r.revision_no}` },
    { key: 'status', label: 'Status', render: r => <ScStatus status={r.status} />,
      export: r => scLabel(r.status), sortValue: r => r.status },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product', render: r => (
        <span>{r.product_name || '—'}{r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
      export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
    { key: 'orders', label: 'Sales Orders', sortable: false,
      render: r => (r.orders?.length ? r.orders.map(o => o.po_number).join(', ') : '—'),
      export: r => (r.orders || []).map(o => o.po_number).join(', ') || '—',
      searchValue: r => (r.orders || []).map(o => o.po_number).join(' ') },
    { key: 'colour_system', label: 'Colours', render: r => (
        <span>{r.colour_system || '—'}{r.num_colours ? <span className="text-slate-400"> · {r.num_colours}c</span> : ''}</span>),
      export: r => `${r.colour_system || '—'}${r.num_colours ? ` (${r.num_colours})` : ''}` },
    { key: 'artwork_no', label: 'Artwork', render: r => (
        r.artwork_no ? <span>{r.artwork_no}{r.artwork_rev && <span className="text-slate-400"> / {r.artwork_rev}</span>}</span> : '—'),
      export: r => r.artwork_no ? `${r.artwork_no}${r.artwork_rev ? ` / ${r.artwork_rev}` : ''}` : '—' },
    { key: 'sent_to_customer_date', label: 'Sent → Approved', sortValue: r => r.sent_to_customer_date || '',
      render: r => (
        <span className="whitespace-nowrap text-xs">
          {r.sent_to_customer_date ? fmt.date(r.sent_to_customer_date) : '—'}
          <ArrowRight size={11} className="mx-1 inline text-slate-300" />
          {r.approval_received_date
            ? <span className="font-semibold text-emerald-700">{fmt.date(r.approval_received_date)}</span>
            : r.expected_approval_date
              ? <span className={r.expected_approval_date < today() ? 'font-semibold text-red-600' : 'text-slate-500'}>
                  exp. {fmt.date(r.expected_approval_date)}</span>
              : '—'}
        </span>),
      export: r => `${r.sent_to_customer_date || '—'} → ${r.approval_received_date || (r.expected_approval_date ? `exp. ${r.expected_approval_date}` : '—')}` },
    { key: 'approval_method', label: 'Approval', render: r => (
        r.status === 'customer_approved'
          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
              <BadgeCheck size={13} />{fmt.title(r.approval_method || 'received')}
              {!!r.customer_stamp && <Stamp size={12} className="text-emerald-600" title="Customer stamp on record" />}
            </span>
          : r.internal_approval_date
            ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700"><ShieldCheck size={13} />Internal</span>
            : <span className="text-xs text-slate-400">—</span>),
      export: r => APPROVAL_CLASS_LABEL[r.approval_class] || '—' },
    { key: 'production_eligible', label: 'Production', render: r => (
        r.production_eligible
          ? <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"><CheckCircle2 size={13} />Clear</span>
          : <span className={`inline-flex items-center gap-1 text-xs font-bold ${r.production_block_hard ? 'text-red-600' : 'text-amber-600'}`}>
              <AlertTriangle size={13} />{r.production_block_hard ? 'Blocked' : 'Alarm'}</span>),
      export: r => r.production_eligible ? 'Eligible' : (r.production_block_hard ? 'Blocked' : 'Soft alarm'),
      sortValue: r => (r.production_eligible ? 2 : r.production_block_hard ? 0 : 1) },
    { key: 'dock_zone', label: 'Card Location', render: r => {
        const d = DOCK_META[r.dock_zone] || DOCK_META.triage;
        return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${d.cls}`}>
          {d.label}{r.dock_zone === 'on_press' && r.issued_machine_name ? ` · ${r.issued_machine_name}` : ''}</span>;
      }, export: r => DOCK_META[r.dock_zone]?.label || r.dock_zone },
    { key: 'age_days', label: 'Age', align: 'right', sortValue: r => r.age_days ?? -1,
      render: r => r.age_days == null ? '—'
        : <span className={`font-semibold tabular-nums ${r.expired_by_age ? 'text-red-600' : r.age_days >= 335 ? 'text-amber-600' : 'text-slate-600'}`}>{r.age_days}d</span>,
      export: r => r.age_days != null ? `${r.age_days}d` : '—' },
    { key: 'updated_at', label: 'Updated', render: r => fmt.dt(r.updated_at), export: r => fmt.dt(r.updated_at) },
  ];

  const exportSummary = rowsIn => [
    { label: 'Cards', value: fmt.num(rowsIn.length) },
    { label: 'Customer approved', value: fmt.num(rowsIn.filter(r => r.status === 'customer_approved').length) },
    { label: 'With customer', value: fmt.num(rowsIn.filter(r => ['sent_to_customer', 'customer_reviewing'].includes(r.status)).length) },
    { label: 'Expired', value: fmt.num(rowsIn.filter(r => r.expired_by_age).length) },
  ];

  // ── Detail drawer content pieces ─────────────────────────────────────────────
  const d = detail;
  const dockMachine = stations.machines.find(m => String(m.id) === String(dock.machine_id));
  const dockJobs = stations.jobs.filter(j => String(j.machine_id) === String(dock.machine_id));

  return (
    <div className="space-y-5">
      <PageHeader title="Shade Card Management"
        subtitle="Quality · Customer approvals, revisions & production eligibility — the single source of truth"
        actions={canManage() && (
          <Button onClick={() => setCreating({ ...emptyForm })}><Plus size={14} /> New Shade Card</Button>
        )} />

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the shade cards can’t load'}. Retrying every 20 seconds…
        </div>
      )}

      {/* KPI band */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Live cards" value={fmt.num(buckets.live.length)} icon={SwatchBook} />
        <KpiCard label="Pending internal" value={fmt.num(buckets.pending_internal.length)} icon={ShieldCheck}
          chip="bg-amber-50 text-amber-600" accent={buckets.pending_internal.length ? 'text-amber-600' : undefined} />
        <KpiCard label="With customer" value={fmt.num(buckets.with_customer.length)} icon={Send}
          chip="bg-violet-50 text-violet-600" accent={buckets.with_customer.length ? 'text-violet-600' : undefined} />
        <KpiCard label="Overdue" value={fmt.num(overdueCount)} icon={Clock4}
          chip="bg-red-50 text-red-600" accent={overdueCount ? 'text-red-600' : undefined} />
        <KpiCard label="Customer approved" value={fmt.num(buckets.approved.length)} icon={BadgeCheck}
          chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
        <KpiCard label="Needs attention" value={fmt.num(buckets.attention.length)} icon={AlertTriangle}
          chip="bg-orange-50 text-orange-600" accent={buckets.attention.length ? 'text-orange-600' : undefined} />
      </div>

      {/* Critical alert banner */}
      {critical.length > 0 && (
        <div className="glass rounded-[22px] border border-red-200/60 bg-red-50/60 p-4">
          <p className="mb-1.5 flex items-center gap-2 text-sm font-extrabold text-red-700">
            <AlertTriangle size={15} /> {critical.length} critical shade-card alert{critical.length > 1 ? 's' : ''}
          </p>
          <ul className="space-y-1">
            {critical.slice(0, 5).map((a, i) => (
              <li key={i} className="text-xs font-medium text-red-700/90">
                <button className="underline decoration-red-300 underline-offset-2" onClick={() => openDetail(a.id)}>
                  {a.message}
                </button>
              </li>))}
            {critical.length > 5 && <li className="text-xs text-red-500">…and {critical.length - 5} more in the Alerts view</li>}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubTabs active={view} onChange={setView} views={[
          { key: 'register', label: 'Register', icon: SwatchBook },
          { key: 'alerts', label: 'Alerts', icon: AlertTriangle, count: alerts.length },
          { key: 'reports', label: 'Reports', icon: FileClock },
        ]} />
        {view === 'register' && (
          <div className="flex flex-wrap items-center gap-3">
            <Tabs active={tab} onChange={setTab} tabs={[
              { key: 'live', label: 'All Live', count: buckets.live.length },
              { key: 'pending_internal', label: 'Pending Internal', count: buckets.pending_internal.length },
              { key: 'with_customer', label: 'With Customer', count: buckets.with_customer.length },
              { key: 'approved', label: 'Approved', count: buckets.approved.length },
              { key: 'attention', label: 'Attention', count: buckets.attention.length },
              { key: 'archived', label: 'Archive', count: buckets.archived.length },
            ]} />
          </div>
        )}
      </div>

      {view === 'register' && (
        <DataTable
          exportName="shade-cards"
          exportSubtitle="Shade Card Management register"
          exportMeta={() => [`Tab: ${fmt.title(tab)}`, q ? `Search: "${q}"` : null]}
          exportSummary={exportSummary}
          rows={filtered}
          columns={columns}
          searchable
          onRowClick={r => openDetail(r.id)}
          defaultSort={{ key: 'updated_at', dir: 'desc' }}
          empty="No shade cards here — create one or switch tabs"
        />
      )}

      {view === 'alerts' && (
        <div className="ci-data-panel divide-y divide-slate-100">
          {alerts.length === 0 && <p className="p-6 text-sm text-slate-400">No alerts — every card is where it should be.</p>}
          {alerts.map((a, i) => (
            <button key={i} onClick={() => openDetail(a.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-blue-50/40">
              <span className={`mt-0.5 rounded-full p-1.5 ${a.severity === 'critical' ? 'bg-red-50 text-red-600'
                : a.severity === 'warn' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                <AlertTriangle size={14} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-800">{a.message}</span>
                <span className="text-xs text-slate-400">{fmt.title(a.kind)} · {a.customer_name || '—'}</span>
              </span>
            </button>))}
        </div>
      )}

      {view === 'reports' && (
        <div className="space-y-4">
          {!reports ? <p className="text-sm text-slate-400">Loading reports…</p> : <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Avg approval TAT" value={reports.kpis.avg_tat_days != null ? `${reports.kpis.avg_tat_days}d` : '—'} icon={Clock4} />
              <KpiCard label="Overdue approvals" value={fmt.num(reports.kpis.overdue)} icon={AlertTriangle}
                chip="bg-red-50 text-red-600" accent={reports.kpis.overdue ? 'text-red-600' : undefined} />
              <KpiCard label="Active approved" value={fmt.num(reports.kpis.approved)} icon={BadgeCheck}
                chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
              <KpiCard label="Expired" value={fmt.num(reports.kpis.expired)} icon={FileClock}
                chip="bg-orange-50 text-orange-600" accent={reports.kpis.expired ? 'text-orange-600' : undefined} />
            </div>
            <DataTable
              exportName="shade-card-tat-by-customer" exportSubtitle="Customer-wise approval performance"
              rows={reports.tat_by_customer} serialNumber
              columns={[
                { key: 'customer', label: 'Customer' },
                { key: 'approvals', label: 'Approvals', align: 'right' },
                { key: 'avg_days', label: 'Avg turnaround (days)', align: 'right',
                  render: r => <span className={`font-bold ${r.avg_days > 14 ? 'text-red-600' : r.avg_days > 7 ? 'text-amber-600' : 'text-emerald-700'}`}>{r.avg_days}</span> },
              ]}
              empty="No completed approval cycles yet" />
            <DataTable
              exportName="shade-card-revisions" exportSubtitle="Revision history by card"
              rows={reports.revision_history}
              columns={[
                { key: 'sc_number', label: 'Shade Card' },
                { key: 'title', label: 'Name' },
                { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
                { key: 'revisions', label: 'Revisions', align: 'right' },
                { key: 'last_revised', label: 'Last revised', render: r => fmt.date(r.last_revised) },
              ]}
              empty="No revisions recorded yet" />
            <DataTable
              exportName="shade-cards-awaiting-production" exportSubtitle="Approved cards whose jobs have not reached the floor"
              rows={reports.awaiting_production}
              columns={[
                { key: 'sc_number', label: 'Shade Card' },
                { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
                { key: 'product_name', label: 'Product', render: r => r.product_name || '—' },
                { key: 'planning_status', label: 'Planning', render: r => fmt.title(r.planning_status || '—') },
                { key: 'approval_received_date', label: 'Approved on', render: r => fmt.date(r.approval_received_date) },
              ]}
              empty="Nothing approved is waiting on production" />
          </>}
        </div>
      )}

      {/* ── Create / Edit ── */}
      <Modal open={!!creating} onClose={() => setCreating(null)} title="New Shade Card" wide
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
          <Button disabled={!creating?.title?.trim() || !creating?.product_id}
            onClick={() => act(async () => {
              const card = await api.post('/shade-cards', { ...creating,
                num_colours: creating.num_colours ? +creating.num_colours : null });
              await openDetail(card.id);
            }, 'Shade card created', false).then(() => setCreating(null))}>
            <Plus size={14} /> Create
          </Button>
        </>}>
        {creating && <FormBody draft={creating} setDraft={setCreating} />}
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.sc_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button disabled={!editing?.title?.trim()}
            onClick={() => act(() => api.put(`/shade-cards/${editing.id}`, { ...editing,
              num_colours: editing.num_colours ? +editing.num_colours : null }), 'Shade card updated')
              .then(() => setEditing(null))}>
            Save changes
          </Button>
        </>}>
        {editing && <FormBody draft={editing} setDraft={setEditing} />}
      </Modal>

      {/* ── Detail drawer ── */}
      <Modal open={!!d} onClose={() => setDetail(null)} wide
        title={d ? `${d.sc_number} — ${d.title}` : ''}
        footer={<Button variant="secondary" onClick={() => setDetail(null)}>Close</Button>}>
        {d && (
          <div className="space-y-4">
            {/* Status + workflow actions */}
            <div className="flex flex-wrap items-center gap-2">
              <ScStatus status={d.status} />
              {d.revision_no > 0 && <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-bold text-violet-700">Revision {d.revision_no}</span>}
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${DOCK_META[d.dock_zone]?.cls}`}>{DOCK_META[d.dock_zone]?.label}</span>
              {d.age_days != null && (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${d.expired_by_age ? 'bg-red-50 text-red-700' : d.age_days >= 335 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                  {d.age_days}d old</span>)}
              <span className="ml-auto" />
              {canManage() && d.active === 1 && (
                <Button size="sm" variant="secondary" onClick={() => setEditing({
                  ...emptyForm,
                  ...Object.fromEntries(Object.keys(emptyForm).map(k => [k, d[k] ?? ''])),
                  id: d.id, sc_number: d.sc_number,
                })}><Pencil size={13} /> Edit</Button>)}
            </div>

            {/* Production eligibility */}
            <div className={`rounded-2xl px-4 py-3 text-sm font-semibold ${d.production_eligible
              ? 'bg-emerald-50 text-emerald-700'
              : d.production_block_hard ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
              {d.production_eligible
                ? <><CheckCircle2 size={14} className="mr-1.5 inline" />Production clear — {APPROVAL_CLASS_LABEL[d.approval_class]}</>
                : <><AlertTriangle size={14} className="mr-1.5 inline" />{d.production_block_reason}</>}
              <span className="mt-0.5 block text-xs font-medium opacity-75">
                Requirement: {d.requirement === 'customer' ? 'customer approval mandatory' : 'internal approval sufficient'}
                {' · '}sourced {d.product_requirement ? 'from the product master' : d.customer_requirement ? 'from the customer master' : 'from this card'}
              </span>
            </div>

            {/* Workflow buttons */}
            {canManage() && d.active === 1 && (
              <div className="flex flex-wrap gap-1.5">
                {(NEXT[d.status] || []).map(next => (
                  <Button key={next} size="sm"
                    variant={next === 'customer_approved' ? 'success' : next === 'rejected' ? 'danger' : 'primary'}
                    onClick={() => ['internal_approved', 'sent_to_customer', 'customer_approved'].includes(next)
                      ? openAction(next, d)
                      : act(() => api.post(`/shade-cards/${d.id}/status`, { to: next }), `${d.sc_number} → ${scLabel(next)}`)}>
                    {next === 'sent_to_customer' && <Send size={13} />}
                    {next === 'customer_approved' && <BadgeCheck size={13} />}
                    {next === 'internal_approved' && <ShieldCheck size={13} />}
                    {next === 'rejected' && <XCircle size={13} />}
                    {scLabel(next)}
                  </Button>))}
                {!['superseded', 'archived'].includes(d.status) && (
                  <Button size="sm" variant="secondary" onClick={() => openAction('revise', d)}>
                    <RotateCcw size={13} /> New Revision</Button>)}
                {!['archived'].includes(d.status) && (
                  <Button size="sm" variant="ghost" onClick={() =>
                    act(() => api.post(`/shade-cards/${d.id}/status`, { to: 'archived' }), `${d.sc_number} archived`)}>
                    <Archive size={13} /> Archive</Button>)}
                <span className="ml-auto" />
                <Button size="sm" variant="danger" onClick={() => setConfirmDel(d)}><Trash2 size={13} /> Delete</Button>
              </div>
            )}

            {/* Identity & approval facts */}
            <div className="grid gap-3 sm:grid-cols-2">
              <section className="ci-form-panel">
                <div className="ci-form-panel-title">Card & colour</div>
                <dl className="space-y-1.5 text-sm">
                  {[['Customer', d.customer_name], ['Product', d.product_name && `${d.product_name} · ${d.product_code || ''}`],
                    ['Artwork', d.artwork_no && `${d.artwork_no}${d.artwork_rev ? ` / Rev ${d.artwork_rev}` : ''}`],
                    ['Colour system', d.colour_system && `${d.colour_system}${d.num_colours ? ` · ${d.num_colours} colours` : ''}`],
                    ['Print process', d.print_process], ['Print reference', d.print_reference],
                    ['Colour details', d.colour_details], ['Made on', d.creation_date && fmt.date(d.creation_date)],
                    ['Location', d.location], ['Remarks', d.remarks],
                    ['Superseded by', d.superseded_by_number]]
                    .filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <dt className="shrink-0 text-slate-400">{k}</dt>
                        <dd className="text-right font-semibold text-slate-800">{v}</dd>
                      </div>))}
                </dl>
              </section>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title">Approval trail</div>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-400">Classification</dt>
                    <dd className="text-right font-semibold text-slate-800">{APPROVAL_CLASS_LABEL[d.approval_class]}</dd>
                  </div>
                  {[['Internal QC stamp', d.internal_qc_stamp ? 'Yes' : d.internal_approval_date ? 'No' : null],
                    ['Internal signatory', d.internal_signatory],
                    ['Internal approved on', d.internal_approval_date && fmt.date(d.internal_approval_date)],
                    ['Sent to customer', d.sent_to_customer_date && fmt.date(d.sent_to_customer_date)],
                    ['Expected response', d.expected_approval_date && fmt.date(d.expected_approval_date)],
                    ['Approval received', d.approval_received_date && fmt.date(d.approval_received_date)],
                    ['Received by', d.approval_received_by],
                    ['Method', d.approval_method && fmt.title(d.approval_method)],
                    ['Customer stamp', d.status === 'customer_approved' ? (d.customer_stamp ? 'Yes' : 'No') : null],
                    ['Customer signature', d.status === 'customer_approved' ? (d.customer_signature ? 'Yes' : 'No') : null],
                    ['Approved by (customer)', d.customer_contact_name && `${d.customer_contact_name}${d.customer_designation ? `, ${d.customer_designation}` : ''}${d.customer_company ? ` — ${d.customer_company}` : ''}`],
                    ['Approval remarks', d.approval_remarks]]
                    .filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <dt className="shrink-0 text-slate-400">{k}</dt>
                        <dd className="text-right font-semibold text-slate-800">{v}</dd>
                      </div>))}
                </dl>
              </section>
            </div>

            {/* Linked ERP status */}
            <section className="ci-summary-panel p-4">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">Live ERP status</div>
              <div className="flex flex-wrap gap-4 text-sm">
                <span>Planning: <b>{fmt.title(d.planning_status || '—')}</b></span>
                <span>Job Card: <b>{d.latest_jc_number ? `${d.latest_jc_number} · ${fmt.title(d.latest_jc_status)}` : '—'}</b></span>
                <span>Documents: <b>{d.docs_count}</b></span>
                {d.dock_zone === 'on_press' && (
                  <span>On press: <b>{d.issued_machine_name} · {d.issued_operator}</b>
                    {d.issued_jc_number ? ` (auto-returns with ${d.issued_jc_number})` : ''}</span>)}
              </div>
            </section>

            {/* Sales orders */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><Link2 size={13} className="mr-1 inline" />Sales Orders</div>
              <div className="space-y-2">
                {(d.orders || []).length === 0 && <p className="text-sm text-slate-400">Not linked to any sales order yet.</p>}
                {(d.orders || []).map(o => (
                  <div key={o.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                    <span className="font-semibold text-slate-800">{o.po_number}
                      <span className="ml-2 text-xs text-slate-400">{fmt.title(o.status)}{o.order_date ? ` · ${fmt.date(o.order_date)}` : ''}</span>
                    </span>
                    {canManage() && (
                      <Button size="sm" variant="ghost" onClick={() =>
                        act(() => api.del(`/shade-cards/${d.id}/orders/${o.id}`), 'Order unlinked')}>Unlink</Button>)}
                  </div>))}
                {canManage() && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Select value={linkOrder} onChange={e => setLinkOrder(e.target.value)}>
                        <option value="">Link a sales order…</option>
                        {orders
                          .filter(o => !(d.orders || []).some(x => x.id === o.id))
                          .filter(o => !d.customer_id || o.customer_id === d.customer_id)
                          .map(o => <option key={o.id} value={o.id} data-search={searchText(o)}>{o.po_number} — {o.customer_name}</option>)}
                      </Select>
                    </div>
                    <Button size="sm" disabled={!linkOrder} onClick={() =>
                      act(() => api.post(`/shade-cards/${d.id}/orders`, { order_id: +linkOrder }), 'Order linked')
                        .then(() => setLinkOrder(''))}>Link</Button>
                  </div>)}
              </div>
            </section>

            {/* Documents */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><Paperclip size={13} className="mr-1 inline" />Supporting documents</div>
              <div className="space-y-2">
                {(d.docs || []).map(doc => (
                  <div key={doc.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <button className="block truncate font-semibold text-brand-600 underline-offset-2 hover:underline"
                        onClick={() => openDoc(doc)}>{doc.title || doc.file_name}</button>
                      <span className="text-xs text-slate-400">
                        {DOC_TYPES.find(t => t.value === doc.doc_type)?.label || fmt.title(doc.doc_type)} · Rev {doc.revision_no}
                        {' · '}{doc.uploaded_by} · {fmt.dt(doc.created_at)}
                        {doc.size_bytes ? ` · ${Math.max(1, Math.round(doc.size_bytes / 1024))} KB` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openDoc(doc)}><Download size={13} /></Button>
                      {canManage() && (
                        <Button size="sm" variant="ghost" onClick={() =>
                          act(() => api.del(`/shade-cards/docs/${doc.id}`), 'Document removed')}>
                          <Trash2 size={13} /></Button>)}
                    </span>
                  </div>))}
                {canManage() && (
                  <div className="grid gap-2 rounded-xl border border-dashed border-slate-200 p-3 sm:grid-cols-[1fr_auto_auto]">
                    <input type="file" className="text-xs"
                      onChange={e => setDocForm(f => ({ ...f, file: e.target.files?.[0] || null }))} />
                    <div className="w-44">
                      <Select value={docForm.doc_type} options={DOC_TYPES}
                        onChange={e => setDocForm(f => ({ ...f, doc_type: e.target.value }))} />
                    </div>
                    <Button size="sm" disabled={!docForm.file} onClick={() =>
                      act(() => api.upload(`/shade-cards/${d.id}/docs`, docForm.file,
                        { doc_type: docForm.doc_type, note: docForm.note }), 'Document attached')
                        .then(() => setDocForm({ file: null, doc_type: 'shade_card_pdf', note: '' }))}>
                      <Paperclip size={13} /> Attach</Button>
                  </div>)}
              </div>
            </section>

            {/* Dock control */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><Printer size={13} className="mr-1 inline" />Physical card — dock control</div>
              {d.dock_zone === 'on_press' ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-800">
                    On <b>{d.issued_machine_name}</b> with {d.issued_operator}
                    {d.issued_jc_number && <span className="text-slate-400"> — auto-returns when {d.issued_jc_number} finishes printing</span>}
                  </p>
                  {canMove() && (
                    <Button size="sm" variant="success" onClick={() =>
                      act(() => api.post(`/shade-cards/${d.id}/return-to-vault`), 'Returned to vault — verified & stored')}>
                      <Vault size={13} /> Run complete → Vault</Button>)}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-slate-500">
                    Card is in <b>{DOCK_META[d.dock_zone]?.label}</b>{d.verified ? ' · Verified & in storage' : ''}.
                    Issue it to a press for the run — it returns to the vault automatically when the attached job finishes printing.
                  </p>
                  {canMove() && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                      <Select value={dock.machine_id} placeholder="Press…"
                        onChange={e => setDock(f => ({ ...f, machine_id: e.target.value, operator: '', job_card_id: '' }))}>
                        <option value="">Press…</option>
                        {stations.machines.map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>)}
                      </Select>
                      <Select value={dock.operator} onChange={e => setDock(f => ({ ...f, operator: e.target.value }))}>
                        <option value="">Operator…</option>
                        {(dockMachine?.operators || []).map(o => <option key={o.id} value={o.name} data-search={searchText(o)}>{o.name}</option>)}
                      </Select>
                      <Select value={dock.job_card_id} onChange={e => setDock(f => ({ ...f, job_card_id: e.target.value }))}>
                        <option value="">Attach print job (optional)…</option>
                        {dockJobs.map(j => <option key={j.job_card_id} value={j.job_card_id} data-search={searchText(j)}>{j.jc_number} — {j.product_name}</option>)}
                      </Select>
                      <div className="flex gap-1.5">
                        <Button size="sm" disabled={!dock.machine_id || !dock.operator} onClick={() =>
                          act(() => api.post(`/shade-cards/${d.id}/issue`, {
                            machine_id: +dock.machine_id, operator: dock.operator,
                            job_card_id: dock.job_card_id ? +dock.job_card_id : undefined,
                          }), 'Issued to press').then(() => setDock({ machine_id: '', operator: '', job_card_id: '' }))}>
                          <Printer size={13} /> Issue</Button>
                        {d.dock_zone === 'triage' && (
                          <Button size="sm" variant="secondary" onClick={() =>
                            act(() => api.post(`/shade-cards/${d.id}/to-vault`), 'Shelved into the vault')}>
                            <Vault size={13} /> Vault</Button>)}
                      </div>
                    </div>)}
                </div>
              )}
            </section>

            {/* Revisions */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><RotateCcw size={13} className="mr-1 inline" />Revision history</div>
              {(d.revisions || []).length === 0
                ? <p className="text-sm text-slate-400">Revision 0 — no revisions raised yet.</p>
                : <div className="space-y-2">
                    {d.revisions.map(rv => (
                      <div key={rv.id} className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                        <p className="font-semibold text-slate-800">Rev {rv.revision_no} → {rv.revision_no + 1}
                          <span className="ml-2 text-xs font-medium text-slate-400">{fmt.dt(rv.created_at)} · {rv.created_by}</span></p>
                        <p className="text-xs text-slate-600">Reason: {rv.reason || '—'}
                          {rv.requested_by && <> · Requested by {rv.requested_by}</>}
                          {rv.approved_by && <> · Approved by {rv.approved_by}</>}</p>
                      </div>))}
                  </div>}
            </section>

            {/* Audit trail */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><History size={13} className="mr-1 inline" />Audit trail</div>
              <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
                {(d.events || []).map(ev => (
                  <div key={ev.id} className="flex items-baseline gap-2 border-l-2 border-slate-100 py-1 pl-3 text-xs">
                    <span className="shrink-0 font-semibold text-slate-700">{fmt.title(ev.action.replace('tooling:', 'Hub: '))}</span>
                    {(ev.from_status || ev.to_status) && (
                      <span className="text-slate-500">{scLabel(ev.from_status) || '·'} → {scLabel(ev.to_status) || '·'}</span>)}
                    {ev.note && <span className="truncate text-slate-400">{ev.note}</span>}
                    <span className="ml-auto shrink-0 text-slate-300">{ev.user_name} · {fmt.dt(ev.at)}</span>
                  </div>))}
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* ── Workflow action modal ── */}
      <Modal open={!!action} onClose={() => setAction(null)}
        title={action ? (action.type === 'revise' ? `New revision — ${action.card.sc_number}`
          : `${scLabel(action.type)} — ${action.card.sc_number}`) : ''}
        footer={action && <>
          <Button variant="secondary" onClick={() => setAction(null)}>Cancel</Button>
          <Button variant={action.type === 'customer_approved' ? 'success' : 'primary'}
            disabled={!actionValid} onClick={runAction}>Confirm</Button>
        </>}>
        {action?.type === 'internal_approved' && (
          <div className="space-y-3">
            <Checkbox label="Internal QC stamp applied" checked={!!action.form.internal_qc_stamp}
              onChange={e => setAf({ internal_qc_stamp: e.target.checked })} />
            <Field label="Authorised signatory">
              <Input value={action.form.internal_signatory} onChange={e => setAf({ internal_signatory: e.target.value })} />
            </Field>
            <Field label="Approval date">
              <Input type="date" value={action.form.internal_approval_date}
                onChange={e => setAf({ internal_approval_date: e.target.value })} />
            </Field>
          </div>)}
        {action?.type === 'sent_to_customer' && (
          <div className="space-y-3">
            <Field label="Sent on" required>
              <Input type="date" value={action.form.sent_to_customer_date}
                onChange={e => setAf({ sent_to_customer_date: e.target.value })} />
            </Field>
            <Field label="Expected approval by">
              <Input type="date" value={action.form.expected_approval_date}
                onChange={e => setAf({ expected_approval_date: e.target.value })} />
            </Field>
          </div>)}
        {action?.type === 'customer_approved' && meta && (
          <div className="space-y-3">
            <Field label="Approval method" required>
              <Select value={action.form.approval_method}
                options={[{ value: '', label: 'How was the approval received?' },
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
              <Checkbox label="Customer stamp available" checked={!!action.form.customer_stamp}
                onChange={e => setAf({ customer_stamp: e.target.checked })} />
              <Checkbox label="Customer signature available" checked={!!action.form.customer_signature}
                onChange={e => setAf({ customer_signature: e.target.checked })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Customer name">
                <Input value={action.form.customer_contact_name}
                  onChange={e => setAf({ customer_contact_name: e.target.value })} />
              </Field>
              <Field label="Designation">
                <Input value={action.form.customer_designation}
                  onChange={e => setAf({ customer_designation: e.target.value })} />
              </Field>
            </div>
            <Field label="Customer company">
              <Input value={action.form.customer_company}
                onChange={e => setAf({ customer_company: e.target.value })} />
            </Field>
            <Field label={action.form.approval_method === 'verbal' ? 'Remarks (mandatory for verbal approval)' : 'Remarks'}
              required={action.form.approval_method === 'verbal'}>
              <Textarea value={action.form.note} onChange={e => setAf({ note: e.target.value })} />
            </Field>
          </div>)}
        {action?.type === 'revise' && (
          <div className="space-y-3">
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
              The current card (Rev {action.card.revision_no}) is frozen into the revision history and both
              approvals reset — the revised shade must be approved again.
            </p>
            <Field label="Reason for revision" required>
              <Textarea value={action.form.reason} onChange={e => setAf({ reason: e.target.value })} />
            </Field>
            <Field label="Requested by">
              <Input value={action.form.requested_by} placeholder="Customer / QC / Sales…"
                onChange={e => setAf({ requested_by: e.target.value })} />
            </Field>
          </div>)}
      </Modal>

      <ConfirmDialog open={!!confirmDel} onClose={() => setConfirmDel(null)} danger
        title={confirmDel ? `Delete ${confirmDel.sc_number}?` : ''}
        message="The card is removed from the register (soft delete) — its audit trail is retained."
        confirmLabel="Delete"
        onConfirm={() => act(() => api.del(`/shade-cards/${confirmDel.id}`), 'Shade card deleted', false)
          .then(() => { setConfirmDel(null); setDetail(null); })} />
    </div>
  );
}
