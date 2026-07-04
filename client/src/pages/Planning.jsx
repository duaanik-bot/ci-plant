// Planning — the CI-Production planning engine, distilled.
// Open a line → requirement + editable cut plan (ups / wastage %) → board
// stock position with committed demand and incoming supply → machine + date
// → lock. Shortfall raises a PR without leaving the modal.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Checkbox, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { CheckCircle2, Wrench, AlertTriangle, PackageSearch, Truck, BookOpen, Palette, Layers } from 'lucide-react';
import WorkflowControls, { BulkWorkflowControls } from '../components/WorkflowControls.jsx';

// Readiness gates on one line: a single "Ready" pill when all pass, otherwise
// compact icon chips (green = cleared, grey = pending, red = material short).
function ReadinessCell({ readiness }) {
  const short = readiness.material ? 0 : Math.max(0, readiness.parent_needed - readiness.available_sheets);
  const gates = [
    { key: 'artwork', label: 'Artwork', icon: Palette, ok: readiness.artwork, hint: readiness.artwork ? 'ready' : 'pending' },
    { key: 'tooling', label: 'Tooling', icon: Wrench, ok: readiness.tooling, hint: readiness.tooling ? 'ready' : 'pending' },
    { key: 'material', label: 'Material', icon: Layers, ok: readiness.material,
      hint: readiness.material ? 'ready' : `short ${fmt.num(short)} parent sheets` },
  ];
  if (gates.every(g => g.ok)) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
        <CheckCircle2 size={12} /> Ready
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {gates.map(g => (
        <span key={g.key} title={`${g.label}: ${g.hint}`}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
            g.ok ? 'bg-emerald-50 text-emerald-600'
              : g.key === 'material' ? 'bg-red-50 text-red-500' : 'bg-slate-100 text-slate-400'
          }`}>
          <g.icon size={12} />
        </span>
      ))}
      {short > 0 && (
        <span className="ml-0.5 whitespace-nowrap text-[10px] font-bold tabular-nums text-red-600"
          title={`Material short ${fmt.num(short)} parent sheets`}>
          −{fmt.num(short)}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, accent = 'text-slate-900' }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`text-sm font-extrabold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

export default function Planning() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [machines, setMachines] = useState([]);
  const [planLine, setPlanLine] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [form, setForm] = useState({ machine_id: '', planned_date: '', tooling_ok: false, ups: '', wastage_pct: '', colors: '', coating: '', special: '' });
  const [prBusy, setPrBusy] = useState(false);
  const [masterPrompt, setMasterPrompt] = useState(null); // { changed: {...} }
  const [selectedIds, setSelectedIds] = useState([]);
  const [tab, setTab] = useState('pending');

  const load = () => api.get('/planning').then(setLines);
  useEffect(() => { load(); api.get('/machines').then(setMachines); }, []);
  const pending = lines.filter(l => l.status === 'pending');
  const planned = lines.filter(l => l.status === 'planned');
  const ready = lines.filter(l => l.status === 'ready');
  const shown = tab === 'pending' ? pending : tab === 'planned' ? planned : ready;
  const selectedLines = lines.filter(l => selectedIds.includes(l.id));
  const clearSelection = () => setSelectedIds([]);
  const toggleSelected = (row, checked) => setSelectedIds(ids => checked
    ? [...new Set([...ids, row.id])]
    : ids.filter(id => id !== row.id));
  const toggleAll = (visibleRows, checked) => {
    const visibleIds = visibleRows.map(r => r.id);
    setSelectedIds(ids => checked
      ? [...new Set([...ids, ...visibleIds])]
      : ids.filter(id => !visibleIds.includes(id)));
  };

  const openPlan = async l => {
    setPlanLine(l); setCtx(null);
    setForm({
      machine_id: l.machine_id || '', planned_date: l.planned_date || '',
      tooling_ok: !!l.tooling_ok, ups: String(l.ups), wastage_pct: String(l.wastage_pct ?? 5),
      colors: String(l.colors ?? ''), coating: l.coating || 'none', special: l.special || 'none',
    });
    setCtx(await api.get(`/planning/${l.id}/context`));
  };

  // Master-driven fields the planner can edit here. The master-update
  // philosophy fires whenever one differs from the Product Master.
  const changedSpec = () => {
    if (!planLine) return {};
    const out = {};
    const cmp = (f, v, isNum) => {
      const cur = isNum ? +v : v;
      const master = isNum ? +planLine[f] : planLine[f];
      if (v !== '' && v != null && String(cur) !== String(master)) out[f] = cur;
    };
    cmp('ups', form.ups, true); cmp('wastage_pct', form.wastage_pct, true);
    cmp('colors', form.colors, true); cmp('coating', form.coating); cmp('special', form.special);
    return out;
  };

  // Live cut-plan math — CI-Production formula: qty / ups + wastage % gives
  // child print sheets; the parent-sheet fit converts to board to issue.
  const calc = useMemo(() => {
    if (!planLine) return null;
    const ups = Math.max(1, +form.ups || planLine.ups);
    const w = Math.max(0, +form.wastage_pct || 0);
    const base = Math.ceil(planLine.qty / ups);
    const total = Math.ceil((planLine.qty / ups) * (1 + w / 100));
    // parent → child fit (both orientations), same math as the server
    const PL = +planLine.sheet_l, PW = +planLine.sheet_w, cl = +planLine.child_l, cw = +planLine.child_w;
    const sized = PL > 0 && PW > 0 && cl > 0 && cw > 0;
    let cpp = 1, waste = null;
    if (sized) {
      cpp = Math.max(Math.floor(PL / cl) * Math.floor(PW / cw), Math.floor(PL / cw) * Math.floor(PW / cl));
      if (cpp > 0) waste = +Math.max(0, 100 - (cpp * cl * cw) / (PL * PW) * 100).toFixed(1);
    }
    const parent = Math.ceil(total / Math.max(1, cpp));
    return { ups, w, base, wastageSheets: total - base, total, sized, cpp: Math.max(1, cpp), waste, parent,
      parentSize: sized ? `${PL}×${PW}"` : null, childSize: sized ? `${cl}×${cw}"` : null };
  }, [planLine, form.ups, form.wastage_pct]);

  const position = useMemo(() => {
    if (!ctx || !calc) return null;
    const available = +ctx.stock.available;
    const committed = +ctx.stock.committed_other;
    const net = available - committed - calc.parent;
    const incoming = ctx.incoming.pos.reduce((s, p) => s + p.pending_qty, 0);
    return { available, committed, net, incoming, short: Math.max(0, -net) };
  }, [ctx, calc]);

  // Clicking Lock: if a master-driven field changed, ask the philosophy question.
  const onLock = () => {
    const changed = changedSpec();
    if (Object.keys(changed).length) setMasterPrompt({ changed });
    else savePlan({ spec: {}, update_master: false });
  };

  const savePlan = async ({ spec, update_master }) => {
    await api.post(`/order-lines/${planLine.id}/plan`, {
      machine_id: +form.machine_id, planned_date: form.planned_date, tooling_ok: form.tooling_ok,
      spec, update_master,
    });
    toast.success(`Plan locked — ${fmt.num(calc.parent)} parent sheets on ${machines.find(m => m.id === +form.machine_id)?.name}`
      + (update_master ? ' · Product Master updated' : Object.keys(spec || {}).length ? ' · saved for this job' : ''));
    setMasterPrompt(null); setPlanLine(null); load();
  };

  const raisePrInline = async () => {
    setPrBusy(true);
    try {
      const pr = await api.post('/requisitions', {
        material_id: ctx.line.board_material_id,
        qty: position.short,
        needed_by: form.planned_date || planLine.delivery_date,
        reason: `Shortfall for ${planLine.product_name} (PO ${planLine.po_number}) — planning engine`,
      });
      toast.success(`${pr.pr_number} raised for ${fmt.num(position.short)} sheets`);
      setCtx(await api.get(`/planning/${planLine.id}/context`));
    } finally { setPrBusy(false); }
  };

  const createJC = async l => {
    await api.post(`/order-lines/${l.id}/job-card`);
    toast.success('Job card created — see Print Planning');
    load();
  };

  return (
    <div>
      <PageHeader title="Planning" subtitle="Requirement → cut plan → board position → machine & date → lock" />
      <Tabs active={tab} onChange={k => { setTab(k); clearSelection(); }} tabs={[
        { key: 'pending', label: 'To Plan', count: pending.length },
        { key: 'planned', label: 'Planned', count: planned.length },
        { key: 'ready', label: 'Ready', count: ready.length },
      ]} />
      <BulkWorkflowControls lines={selectedLines} context="planning" onDone={load} onClear={clearSelection} />
      <DataTable searchable
        selectable
        selectedIds={selectedIds}
        onToggleRow={toggleSelected}
        onToggleAll={toggleAll}
        columns={[
          { key: 'po_number', label: 'PO / Customer', render: l => (<div><div className="font-semibold text-gray-900">{l.po_number}</div><div className="text-xs text-gray-500">{l.customer_name}</div></div>) },
          { key: 'product_name', label: 'Product', render: l => (<div><div>{l.product_name}</div><div className="text-xs text-gray-400">{l.product_code} · {l.colors}c · {fmt.title(l.coating)}{l.special !== 'none' ? ` · ${fmt.title(l.special)}` : ''}</div></div>) },
          { key: 'qty', label: 'Qty', align: 'right', render: l => fmt.num(l.qty) },
          { key: 'sheets_required', label: 'Sheets', align: 'right', render: l => l.sheets_required
            ? (<div><div className="tabular-nums">{fmt.num(l.sheets_required)}</div>{l.parent_sheets_required ? <div className="text-[11px] text-slate-400">{fmt.num(l.parent_sheets_required)} parent</div> : null}</div>)
            : '—' },
          { key: 'delivery_date', label: 'Delivery', render: l => fmt.date(l.delivery_date) },
          { key: 'machine_name', label: 'Machine / Date', render: l => l.machine_name ? (<div><div className="text-xs font-semibold">{l.machine_name}</div><div className="text-xs text-gray-400">{fmt.date(l.planned_date)}</div></div>) : <span className="text-xs text-gray-400">unplanned</span> },
          { key: 'gates', label: 'Readiness', sortable: false, render: l => <ReadinessCell readiness={l.readiness} /> },
          { key: 'status', label: 'Status', render: l => <StatusBadge status={l.status} /> },
          { key: 'act', label: '', sortable: false, render: l => (
            <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
              {l.status === 'ready'
                ? <Button size="sm" variant="success" className="whitespace-nowrap" onClick={() => createJC(l)}>Job Card</Button>
                : <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => openPlan(l)}><Wrench size={13} /> Plan</Button>}
              <WorkflowControls line={l} context="planning" onDone={load} asMenu
                extraItems={l.status === 'ready'
                  ? [{ key: 'engine', label: 'Open Planning Engine', icon: Wrench, onClick: () => openPlan(l) }]
                  : []} />
            </div>) },
        ]}
        rows={shown} empty={tab === 'pending' ? 'No lines waiting for planning' : tab === 'planned' ? 'No planned lines' : 'No lines ready for a job card'} />

      {/* ── Planning Engine ── */}
      <Modal wide open={!!planLine} onClose={() => setPlanLine(null)}
        title={planLine ? `Planning Engine — ${planLine.product_name}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setPlanLine(null)}>Cancel</Button>
          <Button onClick={onLock} disabled={!form.machine_id || !form.planned_date}>
            Lock Plan{calc ? ` — ${fmt.num(calc.parent)} parent sheets` : ''}
          </Button>
        </>}>
        {planLine && (
          <div className="space-y-4">
            {/* Order ribbon */}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Stat label="Customer" value={planLine.customer_name} />
              <Stat label="PO" value={planLine.po_number} />
              <Stat label="Order Qty" value={fmt.num(planLine.qty)} />
              <Stat label="Board" value={planLine.board_name} />
              <Stat label="Delivery" value={fmt.date(planLine.delivery_date)} />
              <Stat label="Status" value={fmt.title(planLine.status)} />
            </div>

            {/* Product spec — auto-populated from the master, editable */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <h4 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                <BookOpen size={13} /> Product Spec <span className="font-medium normal-case tracking-normal text-slate-400">— auto-populated from master, editable</span>
              </h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="Colours">
                  <Input type="number" min="1" max="8" value={form.colors} onChange={e => setForm({ ...form, colors: e.target.value })} />
                </Field>
                <Field label="Coating">
                  <Select value={form.coating} onChange={e => setForm({ ...form, coating: e.target.value })}>
                    {['none', 'aqueous', 'uv', 'matt_lam', 'gloss_lam'].map(o => <option key={o} value={o}>{fmt.title(o)}</option>)}
                  </Select>
                </Field>
                <Field label="Special / finishing">
                  <Select value={form.special} onChange={e => setForm({ ...form, special: e.target.value })}>
                    {['none', 'foil', 'emboss', 'foil_emboss', 'window'].map(o => <option key={o} value={o}>{fmt.title(o)}</option>)}
                  </Select>
                </Field>
              </div>
              {Object.keys(changedSpec()).length > 0 && (
                <p className="mt-2 text-[11px] font-semibold text-amber-600">
                  Edited: {Object.keys(changedSpec()).map(k => fmt.title(k)).join(', ')} — you'll be asked to save for this job or update the master on Lock.
                </p>
              )}
            </div>

            {/* Cut plan — editable, live math */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Cut Plan</h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Field label="Ups / print sheet">
                  <Input type="number" min="1" value={form.ups} onChange={e => setForm({ ...form, ups: e.target.value })} />
                </Field>
                <Field label="Wastage %">
                  <Input type="number" min="0" step="0.5" value={form.wastage_pct} onChange={e => setForm({ ...form, wastage_pct: e.target.value })} />
                </Field>
                {calc && <>
                  <Stat label="Base Print Sheets" value={fmt.num(calc.base)} />
                  <Stat label="+ Wastage" value={fmt.num(calc.wastageSheets)} />
                  <Stat label="Print Sheets Total" value={fmt.num(calc.total)} />
                </>}
              </div>
              {/* Parent → child conversion band */}
              {calc && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs">
                  {calc.sized ? (
                    <>
                      <span className="font-semibold text-slate-700">Parent {calc.parentSize}</span>
                      <span className="text-slate-300">→</span>
                      <span className="font-semibold text-slate-700">child {calc.childSize}</span>
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 font-bold text-brand-700">{calc.cpp} per parent</span>
                      {calc.waste != null && (
                        <span className={`rounded-full px-2 py-0.5 font-bold ${calc.waste <= 10 ? 'bg-emerald-50 text-emerald-700' : calc.waste <= 20 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                          {calc.waste}% cut waste
                        </span>
                      )}
                      <span className="ml-auto font-extrabold tabular-nums text-brand-600">
                        {fmt.num(calc.parent)} parent sheets to issue
                      </span>
                    </>
                  ) : (
                    <span className="text-amber-600">No sheet sizes on this board/product — add parent & print sheet sizes in Masters for the cut fit. Issuing 1:1.</span>
                  )}
                </div>
              )}
            </div>

            {/* Board position + incoming supply */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <h4 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                <PackageSearch size={13} /> Board Position — {planLine.board_name}
              </h4>
              {!ctx ? <p className="py-4 text-center text-xs text-slate-400">Loading warehouse…</p> : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <Stat label="Available (parent)" value={fmt.num(position.available)} />
                    <Stat label="Committed (other jobs)" value={fmt.num(position.committed)} accent={position.committed > 0 ? 'text-amber-600' : 'text-slate-900'} />
                    <Stat label="This Plan (parent)" value={fmt.num(calc.parent)} />
                    <Stat label="Net After Plan" value={fmt.num(position.net)}
                      accent={position.net >= 0 ? 'text-emerald-600' : 'text-red-600'} />
                    <Stat label="Incoming (open POs)" value={fmt.num(position.incoming)} accent="text-brand-600" />
                  </div>

                  {(ctx.incoming.prs.length > 0 || ctx.incoming.pos.length > 0) && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {ctx.incoming.prs.map(p => (
                        <span key={p.pr_number} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                          <Truck size={11} /> {p.pr_number} · {fmt.num(p.qty)} · {fmt.title(p.status)}
                        </span>
                      ))}
                      {ctx.incoming.pos.map(p => (
                        <span key={p.po_number} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                          <Truck size={11} /> {p.po_number} · {fmt.num(p.pending_qty)} due · {p.vendor_name}
                        </span>
                      ))}
                    </div>
                  )}

                  {position.short > 0 && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2.5">
                      <span className="flex items-center gap-2 text-xs font-semibold text-red-700">
                        <AlertTriangle size={14} /> Short by {fmt.num(position.short)} parent sheets after committed demand
                      </span>
                      <Button size="sm" variant="danger" onClick={raisePrInline} disabled={prBusy}>
                        Raise PR for {fmt.num(position.short)}
                      </Button>
                    </div>
                  )}

                  {ctx.batches.length > 0 && (
                    <p className="mt-3 text-[11px] text-slate-400">
                      FIFO batches: {ctx.batches.map(b => `${b.batch_no} (${fmt.num(b.qty)})`).join(' · ')}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Machine + date + tooling */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Printing Machine" required>
                <Select value={form.machine_id} onChange={e => setForm({ ...form, machine_id: e.target.value })}>
                  <option value="">Select press…</option>
                  {machines.filter(m => m.type === 'printing').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Field label="Planned Date" required>
                <Input type="date" value={form.planned_date} onChange={e => setForm({ ...form, planned_date: e.target.value })} />
              </Field>
            </div>
            <Checkbox label="Die & tooling ready" checked={form.tooling_ok} onChange={e => setForm({ ...form, tooling_ok: e.target.checked })} />
          </div>
        )}
      </Modal>

      {/* ── Master-update philosophy prompt ── */}
      <Modal open={!!masterPrompt} onClose={() => setMasterPrompt(null)} title="Save master-driven changes"
        footer={<>
          <Button variant="secondary" onClick={() => setMasterPrompt(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => savePlan({ spec: masterPrompt.changed, update_master: false })}>Save for this Job Only</Button>
          <Button onClick={() => savePlan({ spec: masterPrompt.changed, update_master: true })}>Update Product Master</Button>
        </>}>
        {masterPrompt && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              You changed master-driven fields on <b>{planLine?.product_name}</b>. Do you want to keep the change only for this job, or update the Product Master so every future job uses it?
            </p>
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              {Object.entries(masterPrompt.changed).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700">{fmt.title(k)}</span>
                  <span className="tabular-nums text-slate-500">
                    <span className="line-through">{['coating', 'special'].includes(k) ? fmt.title(String(planLine[k])) : planLine[k]}</span>
                    <span className="mx-1.5 text-slate-300">→</span>
                    <b className="text-slate-900">{['coating', 'special'].includes(k) ? fmt.title(String(v)) : v}</b>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">This master-update choice applies wherever master-driven data is edited across the app.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
