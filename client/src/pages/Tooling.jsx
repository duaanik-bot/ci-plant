// Tooling Hub — ONE lifecycle for the plant's physical tooling: dies, plate
// sets, foil/emboss blocks and shade cards. Incoming → Making → In Rack →
// On Floor. A healthy tool in rack or on the floor satisfies the job-card
// tooling gate automatically — this page is Artwork's sibling station.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmt } from '../api.js';
import {
  Button, DataTable, Field, Input, KpiCard, Modal, PageHeader,
  SearchableSelect, Select, Tabs, Textarea, useToast,
} from '../components/ui.jsx';
import {
  Square, Printer, Stamp, Palette, Factory, Archive, Cog, AlertTriangle,
  Undo2, LayoutGrid, List, Plus, X,
} from 'lucide-react';

const FAMILY_META = {
  die:        { label: 'Die',        plural: 'Dies',        icon: Square,  tint: 'bg-rose-50 text-rose-600' },
  plate:      { label: 'Plate Set',  plural: 'Plates',      icon: Printer, tint: 'bg-sky-50 text-sky-600' },
  block:      { label: 'Block',      plural: 'Blocks',      icon: Stamp,   tint: 'bg-amber-50 text-amber-700' },
  shade_card: { label: 'Shade Card', plural: 'Shade Cards', icon: Palette, tint: 'bg-violet-50 text-violet-600' },
};
const ZONES = [
  { key: 'incoming', label: 'Incoming', desc: 'New & returned — awaiting triage' },
  { key: 'making',   label: 'Making',   desc: 'At vendor / in-house engraving' },
  { key: 'in_rack',  label: 'In Rack',  desc: 'Stored & ready — gate satisfied' },
  { key: 'on_floor', label: 'On Floor', desc: 'Issued to a machine' },
];
const CONDITIONS = ['Good', 'Fair', 'Poor', 'Scrapped'];
const DOT = { Good: 'bg-emerald-500', Fair: 'bg-amber-500', Poor: 'bg-red-500', Scrapped: 'bg-gray-400' };
const STALE = 7 * 86400; // a week stuck in Making = needs attention

const age = s => {
  const d = Math.floor((s ?? 0) / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor((s ?? 0) / 3600);
  return h > 0 ? `${h}h` : 'new';
};
const specLine = t =>
  t.family === 'die' ? [t.ups && `${t.ups} ups`, t.carton_size].filter(Boolean).join(' · ')
    : t.family === 'plate' ? (t.colors ? `${t.colors} colours` : '')
    : t.family === 'block' ? (t.emboss_type ? fmt.title(t.emboss_type) : '')
    : (t.shade_ref || '');

// Spec fields per family — drives the create/edit form.
const SPEC_FIELDS = {
  die: [
    { key: 'ups', label: 'UPS', type: 'number' },
    { key: 'sheet_size', label: 'Sheet Size' },
    { key: 'carton_size', label: 'Carton Size' },
  ],
  plate: [{ key: 'colors', label: 'Colours', type: 'number' }],
  block: [{ key: 'emboss_type', label: 'Block Type', select: ['foil', 'emboss', 'foil_emboss'] }],
  shade_card: [{ key: 'shade_ref', label: 'Shade Reference (e.g. Pantone 2935C)' }],
};

// One uniform compact card — every family, every zone, same size.
function ToolCard({ t, onOpen }) {
  const m = FAMILY_META[t.family];
  return (
    <button onClick={() => onOpen(t)}
      className="ci-line-item w-full text-left transition-shadow duration-200 ease-apple hover:shadow-lift">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${m.tint}`}>
          <m.icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[t.condition]}`} />
            <span className="truncate text-xs font-bold text-[#1D1D1F]">{t.code}</span>
          </span>
          <span className="block truncate text-[11px] text-[#6E6E73]">{t.title}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[10px] font-semibold tabular-nums text-[#86868B]">{age(t.zone_seconds)}</span>
          {specLine(t) && <span className="block max-w-[90px] truncate text-[10px] text-[#AEAEB2]">{specLine(t)}</span>}
        </span>
      </div>
    </button>
  );
}

// Spotlight — full detail, zone moves, condition, event timeline, undo.
function Spotlight({ tool, onClose, onChanged, onEdit }) {
  const toast = useToast();
  const [events, setEvents] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/tools/${tool.id}/events`).then(setEvents).catch(() => {}); }, [tool.id]);
  const m = FAMILY_META[tool.family];

  const move = async zone => {
    setBusy(true);
    try {
      const r = await api.post(`/tools/${tool.id}/move`, { zone, note: note.trim() || undefined });
      toast.success(`${tool.code} → ${ZONES.find(z => z.key === zone).label}` +
        (r.lines_ready ? ` — ${r.lines_ready} job line${r.lines_ready > 1 ? 's' : ''} now ready` : ''));
      onChanged(); onClose();
    } finally { setBusy(false); }
  };
  const setCondition = async condition => {
    if (condition === tool.condition) return;
    await api.put(`/tools/${tool.id}`, { condition });
    toast.success(`${tool.code} marked ${condition}`);
    onChanged(); onClose();
  };
  const undo = async () => {
    await api.post(`/tools/${tool.id}/undo`);
    toast.success('Last move reversed');
    onChanged(); onClose();
  };
  // Only the latest MOVE is reversible — an undo of an undo would 409 server-side.
  const canUndo = events[0]?.action === 'moved';

  return (
    <Modal open onClose={onClose} title={`${tool.code} — ${tool.title}`}
      footer={<>
        <Button variant="ghost" size="sm" onClick={() => onEdit(tool)}>Edit details</Button>
        {canUndo && <Button variant="secondary" size="sm" onClick={undo}><Undo2 size={13} /> Undo last move</Button>}
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${m.tint}`}>
            <m.icon size={12} /> {m.label}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-1 text-xs font-semibold text-[#515154]">
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[tool.condition]}`} /> {tool.condition}
          </span>
          {tool.location && <span className="rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-1 text-xs text-[#515154]">{tool.location}</span>}
          {tool.maker && <span className="rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-1 text-xs text-[#515154]">Maker: {tool.maker}</span>}
        </div>

        {tool.product_name && (
          <p className="text-sm text-[#515154]">
            Linked product: <span className="font-semibold text-[#1D1D1F]">{tool.product_name}</span>
            <span className="text-xs text-[#86868B]"> · {tool.product_code}{tool.customer_name ? ` · ${tool.customer_name}` : ''}</span>
          </p>
        )}
        {specLine(tool) && <p className="text-sm text-[#515154]">Spec: <span className="font-semibold text-[#1D1D1F]">{specLine(tool)}</span></p>}

        {/* Zone lifecycle */}
        <div>
          <p className="ci-form-panel-title border-0 pb-0">Move to</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ZONES.map(z => (
              <button key={z.key} disabled={busy || z.key === tool.zone} onClick={() => move(z.key)}
                className={`rounded-xl border px-2 py-2 text-xs font-semibold transition-all ${
                  z.key === tool.zone
                    ? 'border-[#0A84FF]/40 bg-[#E1EFFF] text-[#0064D2]'
                    : 'border-[#1D1D1F]/[0.08] bg-white/70 text-[#515154] hover:border-[#0A84FF]/40 hover:text-[#007AFF]'}`}>
                {z.label}{z.key === tool.zone ? ' · now' : ''}
              </button>
            ))}
          </div>
          <Input className="mt-2" placeholder="Note for this move (optional)" value={note} onChange={e => setNote(e.target.value)} />
        </div>

        {/* Condition */}
        <div>
          <p className="ci-form-panel-title border-0 pb-0">Condition</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CONDITIONS.map(c => (
              <button key={c} onClick={() => setCondition(c)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
                  c === tool.condition ? 'bg-[#1D1D1F] text-white' : 'bg-[#1D1D1F]/[0.05] text-[#515154] hover:bg-[#1D1D1F]/[0.10]'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${DOT[c]}`} /> {c}
              </button>
            ))}
          </div>
        </div>

        {/* History */}
        <div>
          <p className="ci-form-panel-title border-0 pb-0">History</p>
          <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
            {events.length === 0 && <p className="text-xs text-[#AEAEB2]">No events yet.</p>}
            {events.map(e => (
              <div key={e.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 tabular-nums text-[#86868B]">{fmt.dt(e.at)}</span>
                <span className="text-[#1D1D1F]">
                  {e.action === 'moved' ? `${e.from_zone ? fmt.title(e.from_zone) + ' → ' : ''}${fmt.title(e.to_zone)}`
                    : e.action === 'created' ? 'Created'
                    : e.action === 'undo' ? `Undo → ${fmt.title(e.to_zone)}`
                    : `Condition: ${e.note}`}
                  {e.note && e.action === 'moved' ? ` — ${e.note}` : ''}
                </span>
                {e.user_name && <span className="text-[#AEAEB2]">· {e.user_name}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Create / edit form — family drives which spec fields show.
function ToolForm({ initial, products, onClose, onSaved }) {
  const toast = useToast();
  const editing = !!initial?.id;
  const [f, setF] = useState({
    family: initial?.family || 'die',
    code: initial?.code || '',
    title: initial?.title || '',
    product_id: initial?.product_id ? String(initial.product_id) : '',
    maker: initial?.maker || '',
    location: initial?.location || '',
    notes: initial?.notes || '',
    ups: initial?.ups ?? '', sheet_size: initial?.sheet_size || '', carton_size: initial?.carton_size || '',
    colors: initial?.colors ?? '', emboss_type: initial?.emboss_type || '', shade_ref: initial?.shade_ref || '',
  });
  const set = p => setF(x => ({ ...x, ...p }));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!f.title.trim()) return toast.error('Give the tool a name');
    setSaving(true);
    try {
      const body = {
        ...f, title: f.title.trim(),
        code: f.code.trim() || undefined,
        product_id: f.product_id ? +f.product_id : null,
        ups: f.ups === '' ? null : +f.ups,
        colors: f.colors === '' ? null : +f.colors,
      };
      if (editing) await api.put(`/tools/${initial.id}`, body);
      else await api.post('/tools', body);
      toast.success(editing ? 'Tool updated' : 'Tool added to Incoming');
      onSaved(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${initial.code}` : 'New Tool'}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{editing ? 'Save changes' : 'Add tool'}</Button>
      </>}>
      <div className="ci-form-grid">
        <Field label="Family" required>
          <Select value={f.family} disabled={editing} onChange={e => set({ family: e.target.value })}>
            {Object.entries(FAMILY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label="Code" hint={editing ? undefined : 'Leave empty to auto-number'}>
          <Input value={f.code} disabled={editing} onChange={e => set({ code: e.target.value })}
            placeholder={`${FAMILY_META[f.family].label} code`} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Name" required>
            <Input value={f.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Azithro-500 die" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Linked product" hint="Ties this tool to job readiness — leave empty for shared tools">
            <SearchableSelect value={f.product_id} onChange={e => set({ product_id: e.target.value })}
              placeholder="No product link"
              options={[{ value: '', label: 'No product link' },
                ...products.map(p => ({ value: String(p.id), label: `${p.name} · ${p.code}` }))]} />
          </Field>
        </div>
        {SPEC_FIELDS[f.family].map(s => (
          <Field key={s.key} label={s.label}>
            {s.select
              ? <Select value={f[s.key]} onChange={e => set({ [s.key]: e.target.value })}>
                  <option value="">—</option>
                  {s.select.map(o => <option key={o} value={o}>{fmt.title(o)}</option>)}
                </Select>
              : <Input type={s.type || 'text'} value={f[s.key]} onChange={e => set({ [s.key]: e.target.value })} />}
          </Field>
        ))}
        <Field label="Maker" hint="Vendor name, or In-house">
          <Input value={f.maker} onChange={e => set({ maker: e.target.value })} />
        </Field>
        <Field label="Location" hint="Rack / drawer / cabinet">
          <Input value={f.location} onChange={e => set({ location: e.target.value })} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Notes"><Textarea value={f.notes} onChange={e => set({ notes: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export default function Tooling() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ tools: [], needed: [] });
  const [products, setProducts] = useState([]);
  const [tab, setTab] = useState('all');
  const [view, setView] = useState('board');
  const [spot, setSpot] = useState(null);
  const [form, setForm] = useState(null); // null | {} | {family, product_id} | full tool row

  const load = () => api.get('/tooling/board').then(setData);
  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/products').then(setProducts).catch(() => {}); }, []);

  const productFilter = params.get('product') ? +params.get('product') : null;
  // Migrated dies carry no product_id — the product points at them via
  // tool_id, so the filter must match both directions of the link.
  const linkedToolId = productFilter
    ? products.find(p => p.id === productFilter)?.tool_id ?? null
    : null;
  const tools = useMemo(() => data.tools
    .filter(t => tab === 'all' || t.family === tab)
    .filter(t => !productFilter || t.product_id === productFilter || t.id === linkedToolId),
    [data.tools, tab, productFilter, linkedToolId]);

  const kpi = useMemo(() => ({
    making: data.tools.filter(t => t.zone === 'making').length,
    rack: data.tools.filter(t => t.zone === 'in_rack').length,
    floor: data.tools.filter(t => t.zone === 'on_floor').length,
    attention: data.tools.filter(t => ['Poor', 'Scrapped'].includes(t.condition)
      || (t.zone === 'making' && t.zone_seconds > STALE)).length,
  }), [data.tools]);

  const counts = useMemo(() => Object.fromEntries(
    Object.keys(FAMILY_META).map(k => [k, data.tools.filter(t => t.family === k).length])),
    [data.tools]);

  const filterName = productFilter
    ? (data.tools.find(t => t.product_id === productFilter)?.product_name
      ?? products.find(p => p.id === productFilter)?.name ?? `#${productFilter}`)
    : null;

  return (
    <div>
      <PageHeader title="Tooling Hub"
        subtitle="Dies, plates, blocks & shade cards — from maker to rack to machine"
        actions={<Button onClick={() => setForm({})}><Plus size={15} /> New Tool</Button>} />

      {/* KPI strip */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="In Making" value={kpi.making} icon={Factory} chip="bg-sky-50 text-sky-600"
          sub="At vendor or engraving" />
        <KpiCard label="In Rack" value={kpi.rack} icon={Archive} chip="bg-emerald-50 text-emerald-600"
          sub="Ready — gate satisfied" accent="text-emerald-600" />
        <KpiCard label="On Floor" value={kpi.floor} icon={Cog} chip="bg-indigo-50 text-indigo-600"
          sub="Running on a machine" />
        <KpiCard label="Needs Attention" value={kpi.attention} icon={AlertTriangle}
          chip="bg-red-50 text-red-600" accent={kpi.attention ? 'text-red-600' : 'text-slate-900'}
          sub="Poor condition or stuck a week+" />
      </div>

      {/* Needed for jobs — artwork locked, tooling pending */}
      {data.needed.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#86868B]">
            Needed for jobs — artwork locked, tooling pending
          </p>
          <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
            {data.needed.map(n => (
              <div key={n.line_id} className="glass flex shrink-0 items-center gap-3 rounded-2xl px-3.5 py-2.5">
                <button onClick={() => setParams({ product: String(n.product_id) })} className="text-left">
                  <p className="text-xs font-bold text-[#1D1D1F]">{n.po_number} · {n.product_name}</p>
                  <p className="text-[11px] font-medium text-[#FF3B30]">
                    {n.gaps.map(g => `${g.label} ${g.status === 'missing' ? 'missing' : g.zone === 'making' ? 'at maker' : 'not ready'}`).join(' · ')}
                  </p>
                </button>
                {n.gaps.some(g => g.status === 'missing') && (
                  <Button size="sm" variant="secondary"
                    onClick={() => setForm({ family: n.gaps.find(g => g.status === 'missing').family, product_id: n.product_id })}>
                    <Plus size={13} /> Create
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Family tabs + view toggle + active product filter */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'all', label: 'All', count: data.tools.length },
          ...Object.entries(FAMILY_META).map(([k, m]) => ({ key: k, label: m.plural, count: counts[k] })),
        ]} />
        <div className="mb-4 flex w-fit gap-1 rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-1 backdrop-blur-xl">
          {[['board', LayoutGrid, 'Board'], ['ledger', List, 'Ledger']].map(([k, Icon, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ease-apple ${
                view === k ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        {filterName && (
          <button onClick={() => setParams({})}
            className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[#E1EFFF] px-3 py-1.5 text-xs font-semibold text-[#0064D2] hover:bg-[#D4E8FF]">
            Product: {filterName} <X size={12} />
          </button>
        )}
      </div>

      {view === 'board' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {ZONES.map(z => {
            const zt = tools.filter(t => t.zone === z.key);
            return (
              <div key={z.key} className="glass flex flex-col rounded-[22px]">
                <div className="border-b border-[#1D1D1F]/[0.06] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">{z.label}</p>
                    <span className="rounded-full bg-[#1D1D1F]/[0.06] px-2 text-[11px] font-bold tabular-nums text-[#6E6E73]">{zt.length}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#AEAEB2]">{z.desc}</p>
                </div>
                <div className="flex-1 space-y-2 p-3">
                  {zt.length === 0 && <p className="py-6 text-center text-xs text-[#AEAEB2]">Empty</p>}
                  {zt.map(t => <ToolCard key={t.id} t={t} onOpen={setSpot} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <DataTable searchable onRowClick={setSpot}
          columns={[
            { key: 'code', label: 'Code', render: t => {
              const M = FAMILY_META[t.family];
              return (
                <span className="flex items-center gap-2">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${M.tint}`}><M.icon size={12} /></span>
                  <span className="font-semibold">{t.code}</span>
                </span>);
            } },
            { key: 'title', label: 'Tool' },
            { key: 'product_name', label: 'Product', render: t => t.product_name || <span className="text-gray-300">—</span> },
            { key: 'zone', label: 'Zone', render: t => ZONES.find(z => z.key === t.zone)?.label },
            { key: 'condition', label: 'Condition', render: t => (
              <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${DOT[t.condition]}`} />{t.condition}</span>) },
            { key: 'location', label: 'Location', render: t => t.location || '—' },
            { key: 'zone_seconds', label: 'In zone', render: t => age(t.zone_seconds) },
            { key: 'last_action', label: 'Last action', render: t => t.last_action
              ? `${fmt.title(t.last_action)} · ${fmt.dt(t.last_at)}` : '—' },
          ]}
          rows={tools} empty="No tools yet — add your first with New Tool"
          exportName="Tooling Register"
          exportSubtitle="Tooling Hub · Every die, block and plate with zone and condition" />
      )}

      {spot && <Spotlight tool={spot} onClose={() => setSpot(null)} onChanged={load}
        onEdit={t => { setSpot(null); setForm(t); }} />}
      {form && <ToolForm initial={form} products={products} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}
