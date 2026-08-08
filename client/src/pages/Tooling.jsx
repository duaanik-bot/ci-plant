import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Archive, Boxes, CheckCircle2, ClipboardCheck, Factory,
  FileCheck2, History, Layers3, PackageCheck, Plus, Printer, RotateCcw,
  Send, ShoppingBag, Square, Stamp, Truck, Warehouse, Wrench,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import {
  Button, DataTable, Field, Input, KpiCard, Modal, PageHeader, rowMatches,
  SearchableSelect, Select, SubTabs, Textarea, useToast,
} from '../components/ui.jsx';
import ProductIdentity from '../components/ProductIdentity.jsx';
import ToolingProcurement from '../components/ToolingProcurement.jsx';

export const TOOLING_FAMILY_UI = {
  plate: {
    slug: 'plates', label: 'Plate', plural: 'Plates', icon: Printer,
    subtitle: 'Plate requirements, CTP preparation, vendors and rack release',
    tint: 'bg-sky-50 text-sky-700', accent: 'text-sky-700',
  },
  die: {
    slug: 'dies', label: 'Die', plural: 'Dies', icon: Square,
    subtitle: 'Die requirements, rack reservation, manufacture and usage history',
    tint: 'bg-rose-50 text-rose-700', accent: 'text-rose-700',
  },
  block: {
    slug: 'blocks', label: 'Block', plural: 'Blocks', icon: Stamp,
    subtitle: 'Emboss and foil block requirements from request through release',
    tint: 'bg-amber-50 text-amber-700', accent: 'text-amber-700',
  },
  shade_card: {
    slug: 'shade-cards', label: 'Shade Card', plural: 'Shade Cards', icon: Layers3,
    subtitle: 'Shade requirements, customer approval and production release',
    tint: 'bg-emerald-50 text-emerald-700', accent: 'text-emerald-700',
  },
};

const STATUS = {
  pending: ['Pending', 'bg-slate-100 text-slate-700'],
  rack_reserved: ['Rack reserved', 'bg-emerald-50 text-emerald-700'],
  in_house: ['In-house', 'bg-cyan-50 text-cyan-700'],
  procurement: ['Procurement', 'bg-violet-50 text-violet-700'],
  vendor_assigned: ['Vendor assigned', 'bg-orange-50 text-orange-700'],
  sent_to_vendor: ['Sent to vendor', 'bg-amber-50 text-amber-700'],
  received_from_vendor: ['Received', 'bg-blue-50 text-blue-700'],
  grn_completed: ['GRN complete', 'bg-indigo-50 text-indigo-700'],
  ready: ['Ready', 'bg-emerald-100 text-emerald-800'],
  issued_to_floor: ['On floor', 'bg-blue-100 text-blue-800'],
  returned_to_rack: ['Returned to rack', 'bg-teal-50 text-teal-700'],
  cancelled: ['Cancelled', 'bg-slate-100 text-slate-500'],
  replaced: ['Replaced', 'bg-slate-100 text-slate-500'],
  lost_damaged: ['Lost / damaged', 'bg-red-50 text-red-700'],
};

const SOURCE = {
  rack: ['Rack', Warehouse], in_house: ['In-house', Factory],
  vendor: ['Vendor', Truck], procurement: ['Procurement', ShoppingBag],
};

const terminal = status => ['ready','issued_to_floor','returned_to_rack','cancelled','replaced'].includes(status);
const canManage = () => ['admin', 'planner', 'production'].includes(auth.user?.role);

function StatusChip({ status }) {
  const [label, tone] = STATUS[status] || [fmt.title(status), 'bg-slate-100 text-slate-700'];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold ${tone}`}>{label}</span>;
}

function specText(row) {
  const s = row.specification || {};
  if (row.family === 'plate') return [s.output_number && `Output ${s.output_number}`, s.colors && `${s.colors} colours`, s.colour_type].filter(Boolean).join(' · ');
  if (row.family === 'die') return [s.die_number && `#${s.die_number}`, s.ups && `${s.ups} ups`, s.size].filter(Boolean).join(' · ');
  if (row.family === 'block') return [s.block_number, s.special && fmt.title(s.special), s.leafing_colour].filter(Boolean).join(' · ');
  return [row.sc_number, s.party_artwork_code, s.output_number].filter(Boolean).join(' · ');
}

function SourceButton({ source, active, onClick }) {
  const [label, Icon] = SOURCE[source];
  return (
    <button type="button" onClick={onClick}
      className={`flex min-h-16 items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-bold transition-colors ${active ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
      <Icon size={16} className="shrink-0" /> {label}
    </button>
  );
}

function RequirementModal({ request, tools, vendors, onClose, onChanged }) {
  const toast = useToast();
  const [events, setEvents] = useState([]);
  const [source, setSource] = useState(request.source || 'rack');
  const [form, setForm] = useState({
    tool_id: request.tool_id ? String(request.tool_id) : '',
    vendor_id: request.vendor_id ? String(request.vendor_id) : '',
    rack_location: request.rack_location || '', vendor_reference: request.vendor_reference || '',
    pr_number: request.pr_number || '', po_number: request.po_number || '',
    grn_number: request.grn_number || '', note: request.notes || '',
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/tooling/requirements/${request.id}/events`).then(setEvents).catch(() => {});
  }, [request.id]);

  const mine = tools.filter(t => t.family === request.family
    && (t.product_id === request.product_id || t.id === request.product_tool_id));
  const action = async (name, extra = {}) => {
    setBusy(true);
    try {
      const result = await api.post(`/tooling/requirements/${request.id}/actions`, {
        action: name, note: form.note || undefined,
        tool_id: form.tool_id ? +form.tool_id : undefined,
        vendor_id: form.vendor_id ? +form.vendor_id : undefined,
        rack_location: form.rack_location || undefined,
        vendor_reference: form.vendor_reference || undefined,
        pr_number: form.pr_number || undefined, po_number: form.po_number || undefined,
        grn_number: form.grn_number || undefined,
        ...extra,
      });
      toast.success(name === 'mark_ready'
        ? `Requirement ready${result.lines_ready ? ` · ${result.lines_ready} planning line updated` : ''}`
        : `${request.request_number} updated`);
      await onChanged();
      onClose();
    } finally { setBusy(false); }
  };

  const chooseSource = () => action('choose_source', { source });
  const physical = request.family !== 'shade_card';
  const physicalReady = request.source === 'vendor'
    ? ['received_from_vendor','grn_completed'].includes(request.status)
    : request.source === 'procurement'
      ? request.status === 'grn_completed'
      : Boolean(request.source);
  const canMarkReady = physical ? physicalReady : request.shade_status === 'approved';
  const readyHint = !physical ? 'Approve the linked Shade Card first'
    : !request.source ? 'Choose and confirm a fulfilment source first'
      : request.source === 'vendor' ? 'Receive the tooling from the vendor first'
        : 'Complete the procurement receipt and GRN first';
  const ready = request.status === 'ready';
  const issued = request.status === 'issued_to_floor';

  return (
    <Modal open onClose={onClose} title={`${request.request_number} · ${request.product_name}`} wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {!terminal(request.status) && request.status !== 'lost_damaged' && (
          <Button variant="success" disabled={busy || !canMarkReady} onClick={() => action('mark_ready')}
            title={!canMarkReady ? readyHint : undefined}>
            <CheckCircle2 size={14} /> Mark ready
          </Button>
        )}
      </>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,.75fr)]">
        <div className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-4">
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Job Card</span><p className="text-sm font-bold">{request.jc_number}</p></div>
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Sales Order</span><p className="text-sm font-bold">{request.sales_po_number || '—'}</p></div>
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Needed by</span><p className="text-sm font-bold">{fmt.date(request.needed_by)}</p></div>
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Status</span><p className="mt-0.5"><StatusChip status={request.status} /></p></div>
          </div>

          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Requirement</span><span className="text-slate-400">{specText(request) || 'No additional specification'}</span></div>
            <ProductIdentity row={request} compact />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div><span className="text-[10px] font-bold uppercase text-slate-400">Artwork code</span><p className="text-xs font-semibold">{request.party_artwork_code || '—'}</p></div>
              <div><span className="text-[10px] font-bold uppercase text-slate-400">Party item</span><p className="text-xs font-semibold">{request.party_item_code || '—'}</p></div>
              <div><span className="text-[10px] font-bold uppercase text-slate-400">Available in rack</span><p className="text-xs font-semibold">{fmt.num(request.available_rack_count)}</p></div>
            </div>
          </section>

          {!terminal(request.status) && (
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Fulfilment source</span><span className="text-slate-400">Choose how this requirement will be met</span></div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.keys(SOURCE).map(key => <SourceButton key={key} source={key} active={source === key} onClick={() => setSource(key)} />)}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {source === 'rack' && physical && <>
                  <Field label="Existing rack tool" required>
                    <SearchableSelect value={form.tool_id} onChange={e => setForm(f => ({ ...f, tool_id: e.target.value }))}
                      options={[{ value: '', label: 'Choose a ready tool' }, ...mine.map(t => ({ value: String(t.id), label: `${t.code} · ${t.location || 'No rack'} · ${t.condition}` }))]} />
                  </Field>
                  <Field label="Rack location"><Input value={form.rack_location} onChange={e => setForm(f => ({ ...f, rack_location: e.target.value }))} /></Field>
                </>}
                {source === 'in_house' && <Field label={request.family === 'plate' ? 'CTP / preparation note' : 'Manufacturing note'}>
                  <Input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
                </Field>}
                {source === 'vendor' && <>
                  <Field label="Vendor" required><SearchableSelect value={form.vendor_id} onChange={e => setForm(f => ({ ...f, vendor_id: e.target.value }))}
                    options={[{ value: '', label: 'Choose vendor' }, ...vendors.map(v => ({ value: String(v.id), label: v.name }))]} /></Field>
                  <Field label="Vendor reference"><Input value={form.vendor_reference} onChange={e => setForm(f => ({ ...f, vendor_reference: e.target.value }))} /></Field>
                </>}
                {source === 'procurement' && <>
                  <Field label="Purchase requisition"><Input placeholder="Auto-number if blank" value={form.pr_number} onChange={e => setForm(f => ({ ...f, pr_number: e.target.value }))} /></Field>
                  <Field label="Purchase order"><Input placeholder="Create after PR" value={form.po_number} onChange={e => setForm(f => ({ ...f, po_number: e.target.value }))} /></Field>
                  <Field label="Vendor"><SearchableSelect value={form.vendor_id} onChange={e => setForm(f => ({ ...f, vendor_id: e.target.value }))}
                    options={[{ value: '', label: 'Choose vendor' }, ...vendors.map(v => ({ value: String(v.id), label: v.name }))]} /></Field>
                </>}
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button variant="secondary" disabled={busy
                  || (source === 'rack' && (physical ? !form.tool_id : !request.shade_card_id))
                  || (source === 'vendor' && !form.vendor_id)} onClick={chooseSource}
                  title={source === 'rack' && !physical && !request.shade_card_id ? 'Create or link a Shade Card first' : undefined}>
                  <ClipboardCheck size={14} /> Confirm source
                </Button>
                {source === 'procurement' && <>
                  <Button variant="secondary" disabled={busy} onClick={() => action('create_pr')}><ShoppingBag size={14} /> Create PR</Button>
                  <Button variant="secondary" disabled={busy || !request.pr_number && !form.pr_number} onClick={() => action('create_po')}><FileCheck2 size={14} /> Create PO</Button>
                  <Button variant="secondary" disabled={busy || !form.vendor_id || (!request.po_number && !form.po_number)} onClick={() => action('send_vendor')}><Send size={14} /> Send to vendor</Button>
                </>}
                {source === 'vendor' && <Button variant="secondary" disabled={busy || !form.vendor_id} onClick={() => action('send_vendor')}><Send size={14} /> Send to vendor</Button>}
              </div>
            </section>
          )}

          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Operational actions</span><span className="text-slate-400">Every action is recorded</span></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Movement / decision note"><Textarea value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></Field>
              <div className="flex flex-wrap content-end gap-2">
                {request.status === 'sent_to_vendor' && <Button variant="secondary" onClick={() => action('receive_vendor')}><PackageCheck size={14} /> Receive</Button>}
                {request.status === 'received_from_vendor' && <Button variant="secondary" onClick={() => action('record_grn')}><FileCheck2 size={14} /> Record GRN</Button>}
                {request.family === 'shade_card' && !request.shade_card_id && <Button variant="secondary" onClick={() => action('create_shade_card')}><Plus size={14} /> Create Shade Card</Button>}
                {request.shade_card_id && <Link to={`/shade-cards?q=${encodeURIComponent(request.sc_number || '')}`}><Button variant="secondary"><Layers3 size={14} /> Open Shade Card</Button></Link>}
                {ready && physical && <Button variant="secondary" onClick={() => action('issue_floor')}><Send size={14} /> Issue to floor</Button>}
                {issued && physical && <Button variant="secondary" onClick={() => action('return_rack')}><RotateCcw size={14} /> Return to rack</Button>}
                {request.status === 'lost_damaged' && <Button variant="secondary" onClick={() => action('replace')}><RotateCcw size={14} /> Replace requirement</Button>}
                {!terminal(request.status) && <Button variant="secondary" onClick={() => action('lost_damaged')}><AlertTriangle size={14} /> Lost / damaged</Button>}
                {!terminal(request.status) && <Button variant="ghost" onClick={() => action('cancel')}>Cancel request</Button>}
              </div>
            </div>
          </section>
        </div>

        <aside className="border-l border-slate-200 pl-4">
          <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase text-slate-500"><History size={14} /> Audit trail</p>
          <div className="max-h-[620px] space-y-3 overflow-y-auto pr-1">
            {events.map(event => (
              <div key={event.id} className="border-l-2 border-slate-200 pl-3 text-xs">
                <p className="font-bold text-slate-800">{fmt.title(event.action)}</p>
                <p className="text-slate-500">{event.from_status && event.to_status && event.from_status !== event.to_status ? `${fmt.title(event.from_status)} → ${fmt.title(event.to_status)}` : fmt.title(event.to_status)}</p>
                {event.note && <p className="mt-1 text-slate-600">{event.note}</p>}
                <p className="mt-1 text-[11px] text-slate-400">{fmt.dt(event.at)}{event.user_name ? ` · ${event.user_name}` : ''}</p>
              </div>
            ))}
            {!events.length && <p className="text-xs text-slate-400">No movement recorded yet.</p>}
          </div>
        </aside>
      </div>
    </Modal>
  );
}

function ToolForm({ family, products, initial, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    title: initial?.title || '', code: initial?.code || '',
    product_id: initial?.product_id ? String(initial.product_id) : '',
    maker: initial?.maker || '', location: initial?.location || '', notes: initial?.notes || '',
    ups: initial?.ups ?? '', sheet_size: initial?.sheet_size || '', carton_size: initial?.carton_size || '',
    colors: initial?.colors ?? '', emboss_type: initial?.emboss_type || '', output_no: initial?.output_no || '',
  });
  const set = patch => setForm(current => ({ ...current, ...patch }));
  const save = async () => {
    if (!form.title.trim()) return toast.error('Give the tool a name');
    const body = { ...form, family, product_id: form.product_id ? +form.product_id : null,
      ups: form.ups === '' ? null : +form.ups, colors: form.colors === '' ? null : +form.colors };
    if (initial?.id) await api.put(`/tools/${initial.id}`, body); else await api.post('/tools', body);
    toast.success(initial?.id ? 'Rack asset updated' : 'Rack asset created');
    await onSaved(); onClose();
  };
  return (
    <Modal open onClose={onClose} title={initial?.id ? `Edit ${initial.code}` : `New ${TOOLING_FAMILY_UI[family].label}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <div className="ci-form-grid">
        <Field label="Code" hint={initial?.id ? undefined : 'Leave blank to auto-number'}><Input disabled={!!initial?.id} value={form.code} onChange={e => set({ code: e.target.value })} /></Field>
        <Field label="Name" required><Input value={form.title} onChange={e => set({ title: e.target.value })} /></Field>
        <div className="md:col-span-2"><Field label="Linked product"><SearchableSelect value={form.product_id} onChange={e => set({ product_id: e.target.value })}
          options={[{ value: '', label: 'No product link' }, ...products.map(p => ({ value: String(p.id), label: `${p.name} · ${p.code}` }))]} /></Field></div>
        {family === 'plate' && <><Field label="Colours"><Input type="number" value={form.colors} onChange={e => set({ colors: e.target.value })} /></Field><Field label="Output / Positive No"><Input value={form.output_no} onChange={e => set({ output_no: e.target.value })} /></Field></>}
        {family === 'die' && <><Field label="UPS"><Input type="number" value={form.ups} onChange={e => set({ ups: e.target.value })} /></Field><Field label="Sheet size"><Input value={form.sheet_size} onChange={e => set({ sheet_size: e.target.value })} /></Field><Field label="Carton size"><Input value={form.carton_size} onChange={e => set({ carton_size: e.target.value })} /></Field></>}
        {family === 'block' && <Field label="Block type"><Select value={form.emboss_type} onChange={e => set({ emboss_type: e.target.value })}><option value="">Choose</option><option value="foil">Foil</option><option value="emboss">Emboss</option><option value="foil_emboss">Foil + Emboss</option></Select></Field>}
        <Field label="Maker"><Input value={form.maker} onChange={e => set({ maker: e.target.value })} /></Field>
        <Field label="Rack location"><Input value={form.location} onChange={e => set({ location: e.target.value })} /></Field>
        <div className="md:col-span-2"><Field label="Notes"><Textarea value={form.notes} onChange={e => set({ notes: e.target.value })} /></Field></div>
      </div>
    </Modal>
  );
}

const REQUEST_KPI = {
  open: r => !terminal(r.status),
  pending: r => r.status === 'pending',
  making: r => ['in_house','procurement','vendor_assigned','sent_to_vendor','received_from_vendor','grn_completed'].includes(r.status),
  ready: r => ['ready','issued_to_floor','returned_to_rack'].includes(r.status),
  attention: r => r.status === 'lost_damaged' || (!terminal(r.status) && r.needed_by && r.needed_by < new Date().toISOString().slice(0, 10)),
};

function ToolingOperations({ family = 'shade_card' }) {
  const meta = TOOLING_FAMILY_UI[family] || TOOLING_FAMILY_UI.plate;
  const toast = useToast();
  const [requests, setRequests] = useState([]);
  const [tools, setTools] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [products, setProducts] = useState([]);
  const [shadeCards, setShadeCards] = useState([]);
  const [events, setEvents] = useState([]);
  const [view, setView] = useState('queue');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('all');
  const [kpi, setKpi] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [detail, setDetail] = useState(null);
  const [toolForm, setToolForm] = useState(null);

  const load = async () => {
    const calls = [
      api.get(`/tooling/requirements?family=${family}`).then(setRequests),
      api.get(`/tools?family=${family}`).then(setTools),
      api.get('/vendors').then(setVendors),
      api.get('/products').then(setProducts),
      api.get(`/tooling/requirements/events?family=${family}`).then(setEvents),
    ];
    if (family === 'shade_card') calls.push(api.get('/shade-cards?all=1').then(setShadeCards));
    await Promise.all(calls);
  };
  useEffect(() => { setSelected(new Set()); setKpi(null); setStatus('open'); setView('queue'); load().catch(() => {}); }, [family]);
  useRealtimeRefresh(() => load().catch(() => {}), OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });

  const filtered = useMemo(() => requests.filter(row => {
    if (status === 'open' && terminal(row.status)) return false;
    if (status !== 'all' && status !== 'open' && row.status !== status) return false;
    if (source !== 'all' && row.source !== source) return false;
    if (kpi && !REQUEST_KPI[kpi](row)) return false;
    return !query.trim() || rowMatches(row, query, specText(row));
  }), [requests, status, source, kpi, query]);

  const counts = useMemo(() => Object.fromEntries(Object.entries(REQUEST_KPI).map(([key, predicate]) => [key, requests.filter(predicate).length])), [requests]);
  const selectKpi = key => {
    const next = kpi === key ? null : key;
    setKpi(next);
    setStatus(next ? 'all' : 'open');
  };
  const toggleRow = (row, checked) => setSelected(current => { const next = new Set(current); checked ? next.add(row.id) : next.delete(row.id); return next; });
  const toggleAll = (rows, checked) => setSelected(current => { const next = new Set(current); for (const row of rows) checked ? next.add(row.id) : next.delete(row.id); return next; });
  const bulk = async action => {
    const ids = [...selected];
    const results = await Promise.allSettled(ids.map(id => api.post(`/tooling/requirements/${id}/actions`, { action })));
    const done = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - done;
    if (done) toast.success(`${done} requirement${done === 1 ? '' : 's'} updated`);
    if (failed) toast.error(`${failed} could not be updated; open them for the missing details`);
    setSelected(new Set()); await load();
  };

  const requestColumns = [
    { key: 'request_number', label: 'Request', card: 'title', render: r => <span><b className="text-slate-900">{r.request_number}</b><span className="block text-[11px] text-slate-400">{r.jc_number}</span></span> },
    { key: 'product_name', label: 'Product', card: 'subtitle', render: r => <ProductIdentity row={r} compact /> },
    { key: 'sales_po_number', label: 'Sales Order', render: r => <span>{r.sales_po_number || '—'}<span className="block text-[11px] text-slate-400">{r.customer_name}</span></span> },
    { key: 'needed_by', label: 'Needed by', render: r => fmt.date(r.needed_by) },
    { key: 'specification', label: 'Requirement', sortable: false, render: r => <span className="text-xs text-slate-600">{specText(r) || '—'}</span>, searchValue: specText },
    { key: 'source', label: 'Source', render: r => r.source ? SOURCE[r.source]?.[0] : <span className="font-semibold text-amber-600">Unassigned</span> },
    { key: 'status', label: 'Status', card: 'status', render: r => <StatusChip status={r.status} /> },
    { key: 'tool_code', label: family === 'shade_card' ? 'Card' : 'Rack / Tool', render: r => r.sc_number || r.tool_code ? <span>{r.sc_number || r.tool_code}<span className="block text-[11px] text-slate-400">{r.tool_location || r.rack_location || r.shade_status || ''}</span></span> : `${r.available_rack_count || 0} available` },
    { key: 'last_at', label: 'Last movement', render: r => r.last_at ? <span>{fmt.title(r.last_action)}<span className="block text-[11px] text-slate-400">{fmt.dt(r.last_at)}</span></span> : '—' },
  ];

  const rackColumns = [
    { key: 'code', label: 'Code', render: t => <b>{t.code}</b> },
    { key: 'title', label: meta.label },
    { key: 'product_name', label: 'Product', render: t => t.product_name || 'Shared / unlinked' },
    { key: 'location', label: 'Rack location', render: t => t.location || '—' },
    { key: 'condition', label: 'Condition', render: t => <StatusChip status={t.condition === 'Good' ? 'ready' : t.condition === 'Poor' ? 'lost_damaged' : 'pending'} /> },
    { key: 'last_used_date', label: 'Last used', render: t => fmt.date(t.last_used_date) },
    { key: 'impression_count', label: 'Usage', align: 'right', render: t => fmt.num(t.impression_count) },
    { key: 'zone', label: 'Current state', render: t => fmt.title(t.zone) },
  ];

  const eventColumns = [
    { key: 'at', label: 'When', render: e => fmt.dt(e.at) },
    { key: 'request_number', label: 'Request', render: e => <span><b>{e.request_number}</b><span className="block text-[11px] text-slate-400">{e.jc_number}</span></span> },
    { key: 'product_name', label: 'Product', render: e => `${e.product_name} · ${e.product_code}` },
    { key: 'action', label: 'Movement', render: e => fmt.title(e.action) },
    { key: 'to_status', label: 'Result', render: e => <StatusChip status={e.to_status} /> },
    { key: 'tool_code', label: 'Tool / Vendor', render: e => e.tool_code || e.vendor_name || '—' },
    { key: 'note', label: 'Note', render: e => e.note || '—' },
    { key: 'user_name', label: 'By', render: e => e.user_name || '—' },
  ];

  const cardColumns = [
    { key: 'sc_number', label: 'Card No', render: r => <b>{r.sc_number}</b> },
    { key: 'product_name', label: 'Product', render: r => `${r.product_name || '—'} · ${r.product_code || ''}` },
    { key: 'customer_name', label: 'Customer' },
    { key: 'status', label: 'Approval', render: r => <StatusChip status={r.status === 'approved' ? 'ready' : r.status === 'rejected' ? 'lost_damaged' : 'pending'} /> },
    { key: 'location', label: 'Storage', render: r => r.location || '—' },
    { key: 'updated_at', label: 'Updated', render: r => fmt.dt(r.updated_at) },
  ];

  const views = family === 'shade_card'
    ? [{ key: 'queue', label: 'Queue', icon: ClipboardCheck }, { key: 'rack', label: 'Card Register', icon: Archive }, { key: 'movements', label: 'Movements', icon: History }]
    : [{ key: 'queue', label: 'Queue', icon: ClipboardCheck }, { key: 'rack', label: 'Rack Inventory', icon: Archive }, { key: 'movements', label: 'Movements', icon: History }];

  return (
    <div className="space-y-4">
      <PageHeader title={meta.plural} subtitle={meta.subtitle}
        actions={canManage() && (family === 'shade_card'
          ? <Link to="/shade-cards"><Button variant="secondary"><Layers3 size={14} /> Shade Card workspace</Button></Link>
          : <Button onClick={() => setToolForm({})}><Plus size={14} /> New {meta.label}</Button>)} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Open" value={counts.open} icon={Boxes} sub="Active requirements" onClick={() => selectKpi('open')} active={kpi === 'open'} />
        <KpiCard label="Unassigned" value={counts.pending} icon={ClipboardCheck} sub="Source not decided" onClick={() => selectKpi('pending')} active={kpi === 'pending'} />
        <KpiCard label="In progress" value={counts.making} icon={Factory} sub="Making, vendor or buying" onClick={() => selectKpi('making')} active={kpi === 'making'} />
        <KpiCard label="Ready" value={counts.ready} icon={CheckCircle2} accent="text-emerald-700" sub="Released for production" onClick={() => selectKpi('ready')} active={kpi === 'ready'} />
        <KpiCard label="Attention" value={counts.attention} icon={AlertTriangle} accent={counts.attention ? 'text-red-600' : 'text-slate-900'} sub="Overdue or damaged" onClick={() => selectKpi('attention')} active={kpi === 'attention'} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubTabs active={view} onChange={setView} views={views} />
        {view === 'queue' && <div className="flex flex-wrap items-center gap-2">
          <Select value={status} onChange={e => { setStatus(e.target.value); setKpi(null); }} className="w-44">
            <option value="open">Open requirements</option><option value="all">All statuses</option>
            {Object.entries(STATUS).map(([key, value]) => <option key={key} value={key}>{value[0]}</option>)}
          </Select>
          <Select value={source} onChange={e => setSource(e.target.value)} className="w-40">
            <option value="all">All sources</option>{Object.entries(SOURCE).map(([key, value]) => <option key={key} value={key}>{value[0]}</option>)}
          </Select>
        </div>}
      </div>

      {selected.size > 0 && view === 'queue' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
          <b className="mr-auto text-sm text-brand-900">{selected.size} selected</b>
          <Button size="sm" variant="secondary" onClick={() => bulk('mark_ready')}><CheckCircle2 size={13} /> Mark ready</Button>
          <Button size="sm" variant="ghost" onClick={() => bulk('cancel')}>Cancel requests</Button>
        </div>
      )}

      {view === 'queue' && <DataTable dense selectable rows={filtered} columns={requestColumns}
        selectedIds={[...selected]} onToggleRow={toggleRow} onToggleAll={toggleAll}
        searchValue={query} onSearchChange={setQuery} searchPlaceholder={`Search ${meta.plural.toLowerCase()}, Job Card, product, PO or code…`}
        onRowClick={setDetail} empty={`No ${meta.plural.toLowerCase()} requirements in this queue`}
        defaultSort={{ key: 'needed_by', dir: 'asc' }} exportName={`${meta.plural} Requirements`}
        exportSubtitle={`Tooling Hub · ${meta.plural} job queue`} />}

      {view === 'rack' && (family === 'shade_card'
        ? <DataTable searchable dense rows={shadeCards} columns={cardColumns} onRowClick={r => { window.location.href = `/shade-cards?q=${encodeURIComponent(r.sc_number)}`; }} empty="No shade cards in the register" exportName="Shade Card Register" />
        : <DataTable searchable dense rows={tools} columns={rackColumns} onRowClick={setToolForm} empty={`No ${meta.plural.toLowerCase()} in rack inventory`} exportName={`${meta.plural} Rack Inventory`} />)}

      {view === 'movements' && <DataTable searchable dense rows={events} columns={eventColumns}
        empty="No movements recorded" defaultSort={{ key: 'at', dir: 'desc' }} exportName={`${meta.plural} Movement Ledger`} />}

      {detail && <RequirementModal request={detail} tools={tools} vendors={vendors} onClose={() => setDetail(null)} onChanged={load} />}
      {toolForm && family !== 'shade_card' && <ToolForm family={family} products={products} initial={toolForm.id ? toolForm : null}
        onClose={() => setToolForm(null)} onSaved={load} />}
    </div>
  );
}

export default function Tooling({ family = 'plate' }) {
  if (family !== 'shade_card') return <ToolingProcurement family={family} />;
  return <ToolingOperations family={family} />;
}
