// Planning — the CI-Production planning engine, distilled.
// Open a line → requirement + editable cut plan (ups / wastage %) → board
// stock position with committed demand and incoming supply → machine + date
// → lock. Shortfall raises a PR without leaving the modal.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Checkbox, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, useToast } from '../components/ui.jsx';
import { CheckCircle2, XCircle, Wrench, AlertTriangle, PackageSearch, Truck } from 'lucide-react';

function Gate({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${ok ? 'text-emerald-600' : 'text-gray-400'}`}>
      {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{label}
    </span>
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
  const [form, setForm] = useState({ machine_id: '', planned_date: '', tooling_ok: false, ups: '', wastage_pct: '' });
  const [prBusy, setPrBusy] = useState(false);

  const load = () => api.get('/planning').then(setLines);
  useEffect(() => { load(); api.get('/machines').then(setMachines); }, []);

  const openPlan = async l => {
    setPlanLine(l); setCtx(null);
    setForm({
      machine_id: l.machine_id || '', planned_date: l.planned_date || '',
      tooling_ok: !!l.tooling_ok, ups: String(l.ups), wastage_pct: String(l.wastage_pct ?? 5),
    });
    setCtx(await api.get(`/planning/${l.id}/context`));
  };

  // Live cut-plan math — CI-Production formula: qty / ups, plus wastage %.
  const calc = useMemo(() => {
    if (!planLine) return null;
    const ups = Math.max(1, +form.ups || planLine.ups);
    const w = Math.max(0, +form.wastage_pct || 0);
    const base = Math.ceil(planLine.qty / ups);
    const total = Math.ceil((planLine.qty / ups) * (1 + w / 100));
    return { ups, w, base, wastageSheets: total - base, total };
  }, [planLine, form.ups, form.wastage_pct]);

  const position = useMemo(() => {
    if (!ctx || !calc) return null;
    const available = +ctx.stock.available;
    const committed = +ctx.stock.committed_other;
    const net = available - committed - calc.total;
    const incoming = ctx.incoming.pos.reduce((s, p) => s + p.pending_qty, 0);
    return { available, committed, net, incoming, short: Math.max(0, -net) };
  }, [ctx, calc]);

  const savePlan = async () => {
    await api.post(`/order-lines/${planLine.id}/plan`, {
      machine_id: +form.machine_id, planned_date: form.planned_date, tooling_ok: form.tooling_ok,
      ups_override: +form.ups !== planLine.ups ? +form.ups : undefined,
      wastage_pct_override: +form.wastage_pct !== planLine.wastage_pct ? +form.wastage_pct : undefined,
    });
    toast.success(`Plan locked — ${fmt.num(calc.total)} sheets on ${machines.find(m => m.id === +form.machine_id)?.name}`);
    setPlanLine(null); load();
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
      <DataTable searchable
        columns={[
          { key: 'po_number', label: 'PO / Customer', render: l => (<div><div className="font-semibold text-gray-900">{l.po_number}</div><div className="text-xs text-gray-500">{l.customer_name}</div></div>) },
          { key: 'product_name', label: 'Product', render: l => (<div><div>{l.product_name}</div><div className="text-xs text-gray-400">{l.product_code} · {l.colors}c · {fmt.title(l.coating)}{l.special !== 'none' ? ` · ${fmt.title(l.special)}` : ''}</div></div>) },
          { key: 'qty', label: 'Qty', align: 'right', render: l => fmt.num(l.qty) },
          { key: 'sheets_required', label: 'Sheets', align: 'right', render: l => l.sheets_required ? fmt.num(l.sheets_required) : '—' },
          { key: 'delivery_date', label: 'Delivery', render: l => fmt.date(l.delivery_date) },
          { key: 'machine_name', label: 'Machine / Date', render: l => l.machine_name ? (<div><div className="text-xs font-semibold">{l.machine_name}</div><div className="text-xs text-gray-400">{fmt.date(l.planned_date)}</div></div>) : <span className="text-xs text-gray-400">unplanned</span> },
          { key: 'gates', label: 'Readiness', render: l => (
            <div className="flex flex-col gap-0.5">
              <Gate ok={l.readiness.artwork} label="Artwork" />
              <Gate ok={l.readiness.tooling} label="Tooling" />
              <Gate ok={l.readiness.material} label={l.readiness.material ? 'Material' : `Short ${fmt.num(l.readiness.needed_sheets - l.readiness.available_sheets)}`} />
            </div>) },
          { key: 'status', label: 'Status', render: l => <StatusBadge status={l.status} /> },
          { key: 'act', label: '', render: l => (
            <div className="flex justify-end gap-1.5" onClick={e => e.stopPropagation()}>
              {l.status === 'ready'
                ? <Button size="sm" variant="success" onClick={() => createJC(l)}>Create Job Card</Button>
                : <Button size="sm" variant="secondary" onClick={() => openPlan(l)}><Wrench size={13} /> Plan</Button>}
              {l.status !== 'pending' && l.status !== 'ready' && (
                <Button size="sm" variant="ghost" onClick={() => openPlan(l)}>Engine</Button>
              )}
            </div>) },
        ]}
        rows={lines} empty="No lines waiting for planning" />

      {/* ── Planning Engine ── */}
      <Modal wide open={!!planLine} onClose={() => setPlanLine(null)}
        title={planLine ? `Planning Engine — ${planLine.product_name}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setPlanLine(null)}>Cancel</Button>
          <Button onClick={savePlan} disabled={!form.machine_id || !form.planned_date}>
            Lock Plan{calc ? ` — ${fmt.num(calc.total)} sheets` : ''}
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

            {/* Cut plan — editable, live math */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">Cut Plan</h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Field label="Ups / sheet">
                  <Input type="number" min="1" value={form.ups} onChange={e => setForm({ ...form, ups: e.target.value })} />
                </Field>
                <Field label="Wastage %">
                  <Input type="number" min="0" step="0.5" value={form.wastage_pct} onChange={e => setForm({ ...form, wastage_pct: e.target.value })} />
                </Field>
                {calc && <>
                  <Stat label="Base Sheets" value={fmt.num(calc.base)} />
                  <Stat label="+ Wastage" value={fmt.num(calc.wastageSheets)} />
                  <Stat label="Total Required" value={fmt.num(calc.total)} accent="text-brand-600" />
                </>}
              </div>
            </div>

            {/* Board position + incoming supply */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <h4 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                <PackageSearch size={13} /> Board Position — {planLine.board_name}
              </h4>
              {!ctx ? <p className="py-4 text-center text-xs text-slate-400">Loading warehouse…</p> : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <Stat label="Available" value={fmt.num(position.available)} />
                    <Stat label="Committed (other jobs)" value={fmt.num(position.committed)} accent={position.committed > 0 ? 'text-amber-600' : 'text-slate-900'} />
                    <Stat label="This Plan" value={fmt.num(calc.total)} />
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
                        <AlertTriangle size={14} /> Short by {fmt.num(position.short)} sheets after committed demand
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
    </div>
  );
}
