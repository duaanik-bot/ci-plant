// Tooling Hub — ONE lifecycle for the plant's physical tooling: dies, plate
// sets and foil/emboss blocks. Incoming → Making → In Rack → On Floor. A
// healthy tool in rack or on the floor satisfies the job-card tooling gate
// automatically — this page is Artwork's sibling station. Shade cards moved to
// their own quality module (Shade Card Management).
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmt } from '../api.js';
import {
  Button, ConfirmDialog, DataTable, Field, Input, KpiCard, Modal, PageHeader,
  rowMatches, SearchableSelect, Select, SubTabs, Tabs, Textarea, useToast,
} from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import {
  Square, Printer, Stamp, Factory, Archive, Cog, AlertTriangle,
  Undo2, LayoutGrid, List, Plus, X, Trash2, CheckCircle2, Search,
} from 'lucide-react';

// One batched call paints the thread column for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

// Key order = tab & form order (plant serial per Anik: Plates → Dies → Blocks).
const FAMILY_META = {
  plate:      { label: 'Plate Set',  plural: 'Plates',      icon: Printer, tint: 'bg-sky-50 text-sky-600' },
  die:        { label: 'Die',        plural: 'Dies',        icon: Square,  tint: 'bg-rose-50 text-rose-600' },
  block:      { label: 'Block',      plural: 'Blocks',      icon: Stamp,   tint: 'bg-amber-50 text-amber-700' },
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
// Sizes read as 48×48×120, not 48X48X120.
const dim = s => (s || '').replace(/\s*[xX]\s*/g, '×');
const specLine = t =>
  t.family === 'die' ? [t.ups && `${t.ups} ups`, dim(t.carton_size)].filter(Boolean).join(' · ')
    : t.family === 'plate' ? (t.colors ? `${t.colors} colours` : '')
    : t.family === 'block' ? (t.emboss_type ? fmt.title(t.emboss_type) : '')
    : '';

// Spec fields per family — drives the create/edit form.
const SPEC_FIELDS = {
  die: [
    { key: 'ups', label: 'UPS', type: 'number' },
    { key: 'sheet_size', label: 'Sheet Size' },
    { key: 'carton_size', label: 'Carton Size' },
  ],
  plate: [{ key: 'colors', label: 'Colours', type: 'number' }],
  block: [{ key: 'emboss_type', label: 'Block Type', select: ['foil', 'emboss', 'foil_emboss'] }],
};

// One uniform compact card — every family, every zone, same size.
// Line 1: code + time-in-zone. Line 2: the spec (ups · size) gets the full
// card width — die sizes stay readable without growing the card; the generic
// title trails after it and truncates first.
function ToolCard({ t, onOpen, onDelete }) {
  const m = FAMILY_META[t.family];
  const spec = specLine(t);
  return (
    <div className="group relative">
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
              {/* Age fades on hover so the delete button can take the corner. */}
              <span className="ml-auto shrink-0 pl-2 text-[10px] font-semibold tabular-nums text-[#AEAEB2] transition-opacity group-hover:opacity-0">{age(t.zone_seconds)}</span>
            </span>
            <span className="flex items-center gap-1 text-[11px] leading-4">
              <span className="min-w-0 truncate">
                {spec && <span className="font-semibold tabular-nums text-[#515154]">{spec}</span>}
                {spec && t.title ? <span className="text-[#AEAEB2]"> · </span> : null}
                <span className="text-[#86868B]">{t.title}</span>
              </span>
            </span>
          </span>
        </div>
      </button>
      {/* Sibling (not nested — the card is itself a button). Hover-revealed. */}
      <button onClick={() => onDelete(t)} title={`Delete ${t.code}`} aria-label={`Delete ${t.code}`}
        className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-lg text-[#AEAEB2] transition-colors hover:bg-red-50 hover:text-red-600 group-hover:flex">
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// A retired tool — muted, struck through, no production affordances. Lives only
// in the Archive Hub. Click opens the (read-only) Spotlight with Restore.
function ScrappedCard({ t, onOpen }) {
  const m = FAMILY_META[t.family];
  return (
    <button onClick={() => onOpen(t)}
      className="ci-line-item w-full text-left opacity-50 transition-opacity hover:opacity-80">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${m.tint}`}>
          <m.icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-bold text-[#1D1D1F] line-through">{t.code}</span>
            <span className="ml-auto shrink-0 rounded-full bg-red-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-red-700">Scrapped</span>
          </span>
          <span className="block truncate text-[11px] leading-4 text-[#86868B] line-through">{t.title}</span>
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
  const scrapped = tool.condition === 'Scrapped';
  const restore = async () => {
    await api.put(`/tools/${tool.id}`, { condition: 'Fair' });
    toast.success(`${tool.code} restored to the board`);
    onChanged(); onClose();
  };

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
        {scrapped && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-bold text-red-700">
              <AlertTriangle size={14} /> Scrapped — retired from the floor. Production actions are locked.
            </p>
            <Button size="sm" variant="secondary" onClick={restore}><Undo2 size={13} /> Restore</Button>
          </div>
        )}
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
              <button key={z.key} disabled={busy || scrapped || z.key === tool.zone} onClick={() => move(z.key)}
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
                    : e.action === 'issued' ? `Issued to press${e.note ? ` — ${e.note}` : ''}`
                    : e.action === 'returned' ? `Returned to Vault${e.note ? ` — ${e.note}` : ''}`
                    : e.action === 'deleted' ? 'Deleted'
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
    output_no: initial?.output_no || '', cylinder_no: initial?.cylinder_no || '',
    creation_date: initial?.creation_date || '', approval_date: initial?.approval_date || '',
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
        <Field label="Output / Positive No">
          <Input value={f.output_no} onChange={e => set({ output_no: e.target.value })} />
        </Field>
        <Field label="Dye / Cylinder No">
          <Input value={f.cylinder_no} onChange={e => set({ cylinder_no: e.target.value })} />
        </Field>
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
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ tools: [], needed: [] });
  const [products, setProducts] = useState([]);
  // Entry sequence is the plant's serial: Plates → Dies → Blocks.
  const [tab, setTab] = useState('plate');
  const [view, setView] = useState('board');
  const [spot, setSpot] = useState(null);
  const [form, setForm] = useState(null); // null | {} | {family, product_id} | full tool row
  const [del, setDel] = useState(null); // tool pending delete-confirm
  // Per-column search — each zone (Incoming / Making / In Rack / On Floor) filters
  // only its own cards. Reset when the family tab changes so a stale query never
  // silently hides tools under a different family.
  const [zoneSearch, setZoneSearch] = useState({});
  useEffect(() => { setZoneSearch({}); }, [tab]);

  // The board and the register read the same payload, so one summary covers
  // every family tab — no refetch when the operator switches Plates → Dies.
  const [threads, setThreads] = useState({});
  const load = () => api.get('/tooling/board').then(d => {
    setData(d);
    threadSummary('tool', (d.tools || []).map(t => t.id)).then(setThreads).catch(() => {});
  });
  const removeTool = async () => {
    const t = del;
    try {
      await api.del(`/tools/${t.id}`);
      toast.success(`${t.code} deleted`);
      load();
    } catch (e) { toast.error(e.message || 'Could not delete tool'); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/products').then(setProducts).catch(() => {}); }, []);

  const productFilter = params.get('product') ? +params.get('product') : null;
  // Migrated dies carry no product_id — the product points at them via
  // tool_id, so the filter must match both directions of the link.
  const linkedToolId = productFilter
    ? products.find(p => p.id === productFilter)?.tool_id ?? null
    : null;
  const isArchive = tab === '__archive';
  const tools = useMemo(() => data.tools
    .filter(t => t.family === tab)
    .filter(t => t.condition !== 'Scrapped')
    .filter(t => !productFilter || t.product_id === productFilter || t.id === linkedToolId),
    [data.tools, tab, productFilter, linkedToolId]);
  const scrapped = useMemo(() =>
    data.tools.filter(t => t.condition === 'Scrapped'), [data.tools]);

  const kpi = useMemo(() => ({
    making: data.tools.filter(t => t.zone === 'making').length,
    rack: data.tools.filter(t => t.zone === 'in_rack').length,
    floor: data.tools.filter(t => t.zone === 'on_floor').length,
    attention: data.tools.filter(t => t.condition === 'Poor'
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
          ...Object.entries(FAMILY_META).map(([k, m]) => ({ key: k, label: m.plural, count: counts[k] })),
          { key: '__archive', label: 'Archive', count: scrapped.length },
        ]} />
        {!isArchive && <SubTabs className="mb-4" active={view} onChange={setView} views={[
          { key: 'board', label: 'Board', icon: LayoutGrid },
          { key: 'ledger', label: 'Ledger', icon: List },
        ]} />}
        {filterName && (
          <button onClick={() => setParams({})}
            className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[#E1EFFF] px-3 py-1.5 text-xs font-semibold text-[#0064D2] hover:bg-[#D4E8FF]">
            Product: {filterName} <X size={12} />
          </button>
        )}
      </div>

      {isArchive ? (
        <div className="space-y-5">
          {scrapped.length === 0 && (
            <p className="glass rounded-[22px] py-12 text-center text-sm text-[#AEAEB2]">
              Nothing scrapped — the Archive is empty.
            </p>
          )}
          {Object.entries(FAMILY_META).map(([fam, m]) => {
            const rows = scrapped.filter(t => t.family === fam);
            if (!rows.length) return null;
            return (
              <div key={fam}>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#86868B]">
                  <m.icon size={13} /> {m.plural} <span className="text-[#C7C7CC]">· {rows.length}</span>
                </p>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {rows.map(t => <ScrappedCard key={t.id} t={t} onOpen={setSpot} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : view === 'board' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {ZONES.map(z => {
            const label = z.label;
            const q = zoneSearch[z.key] || '';
            const all = tools.filter(t => t.zone === z.key);
            const zt = q ? all.filter(t => rowMatches(t, q)) : all;
            return (
              <div key={z.key} className="glass flex flex-col rounded-[22px]">
                <div className="border-b border-[#1D1D1F]/[0.06] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">{label}</p>
                    <span className="rounded-full bg-[#1D1D1F]/[0.06] px-2 text-[11px] font-bold tabular-nums text-[#6E6E73]">
                      {q ? `${zt.length}/${all.length}` : all.length}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#AEAEB2]">{z.desc}</p>
                  {/* Per-column search — filters only this zone's cards. */}
                  <div className="relative mt-2">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#AEAEB2]" />
                    <input
                      value={q}
                      onChange={e => setZoneSearch(s => ({ ...s, [z.key]: e.target.value }))}
                      placeholder={`Search ${label}…`}
                      className="w-full rounded-full border border-[#1D1D1F]/[0.10] bg-white/70 py-1.5 pl-7 pr-7 text-[12px] font-medium text-[#1D1D1F] outline-none transition duration-200 ease-apple hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3px] focus:ring-[#0A84FF]/20"
                    />
                    {q && (
                      <button onClick={() => setZoneSearch(s => ({ ...s, [z.key]: '' }))}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-[#AEAEB2] hover:bg-[#1D1D1F]/[0.06] hover:text-[#515154]">
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 space-y-2 p-3">
                  {all.length === 0 && <p className="py-6 text-center text-xs text-[#AEAEB2]">Empty</p>}
                  {all.length > 0 && zt.length === 0 && (
                    <p className="py-6 text-center text-xs text-[#AEAEB2]">No matches for “{q}”</p>
                  )}
                  {zt.map(t => (
                    <div key={t.id}>
                      <ToolCard t={t} onOpen={setSpot} onDelete={setDel} />
                    </div>
                  ))}
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
            threadColumn({ entity: 'tool', threads, idOf: t => t.id }),
          ]}
          rows={tools} empty="No tools yet — add your first with New Tool"
          rowClass={unreadRowClass(threads, t => t.id)}
          getRowId={t => t.id}
          exportName="Tooling Register"
          exportSubtitle="Tooling Hub · Every die, block and plate with zone and condition" />
      )}

      {spot && <Spotlight tool={spot} onClose={() => setSpot(null)} onChanged={load}
        onEdit={t => { setSpot(null); setForm(t); }} />}
      {form && <ToolForm initial={form} products={products} onClose={() => setForm(null)} onSaved={load} />}
      <ConfirmDialog open={!!del} danger onClose={() => setDel(null)} onConfirm={removeTool}
        title="Delete this tool?" confirmLabel="Delete"
        message={del ? `${del.code} — ${del.title} will be removed from the board.` : ''} />
    </div>
  );
}
