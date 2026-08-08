// Machine Logbook — the plant's register, one page per machine.
// Every machine from the master (active or retired) keeps a chronological
// register: production runs pulled live from job_stages (product, time,
// quantities, operator — never re-entered) merged with manual pen lines
// (setup / maintenance / breakdown / idle / remarks). Pick a timeline,
// export the register as a branded PDF or Excel in one click.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import { Button, DataTable, Field, Input, KpiCard, KpiFilterNotice, Modal, PageHeader, searchText, Select, Textarea, useKpiFilter, useToast } from '../components/ui.jsx';
import { NotebookPen, Timer, Layers, AlertTriangle, Wrench, Plus, Trash2, Users } from 'lucide-react';

const TYPE_BADGE = {
  production: 'bg-[#E1EFFF] text-[#0064D2]',
  setup: 'bg-violet-50 text-violet-600',
  maintenance: 'bg-amber-50 text-amber-600',
  breakdown: 'bg-red-50 text-red-600',
  idle: 'bg-slate-100 text-slate-500',
  remark: 'bg-slate-100 text-slate-500',
};
const STATUS_DOT = { running: 'bg-emerald-500', idle: 'bg-amber-400', maintenance: 'bg-red-500' };
const ENTRY_TYPES = ['setup', 'maintenance', 'breakdown', 'idle', 'remark'];

// Section rail follows the plant's process flow, not the alphabet — the way a
// sheet actually moves: cutting → printing → coating → … → pasting → qc.
// Same canonical order the Dashboard WIP funnel uses. Unknown types fall to
// the end, alphabetically, so nothing ever gets dropped.
const FLOW_ORDER = ['cutting', 'ctp', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc'];
const flowRank = t => { const i = FLOW_ORDER.indexOf(t); return i === -1 ? FLOW_ORDER.length : i; };

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const time = ts => (ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : null);

// Register period presets — the timelines Anik asked for.
function presetRange(key) {
  const now = new Date();
  if (key === 'today') return { from: iso(now), to: iso(now) };
  if (key === '7d') { const d = new Date(now); d.setDate(d.getDate() - 6); return { from: iso(d), to: iso(now) }; }
  if (key === 'month') return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  return null;
}

// "09:10 – 12:45" plus run duration, from either timestamps (auto rows)
// or HH:MM strings (manual rows).
function timeSpan(e) {
  const f = e.kind === 'auto' ? time(e.time_from) : e.time_from;
  const t = e.kind === 'auto' ? time(e.time_to) : e.time_to;
  if (!f && !t) return '—';
  return `${f || '—'} – ${t || '…'}`;
}
function duration(e) {
  let mins = null;
  if (e.kind === 'auto' && e.time_from && e.time_to) {
    mins = Math.round((new Date(e.time_to) - new Date(e.time_from)) / 60000);
  } else if (e.kind === 'manual' && e.time_from && e.time_to) {
    const [fh, fm] = e.time_from.split(':').map(Number);
    const [th, tm] = e.time_to.split(':').map(Number);
    if ([fh, fm, th, tm].every(Number.isFinite)) mins = th * 60 + tm - (fh * 60 + fm);
  }
  if (mins == null || mins < 0) return null;
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

const LOG_KPI_ROWS = {
  runs: e => e.entry_type === 'production',
  scrap: e => (+e.qty_scrap || 0) > 0,
  downtime: e => ['maintenance', 'breakdown', 'idle'].includes(e.entry_type),
};
const LOG_KPI_LABEL = {
  runs: 'production entries',
  scrap: 'entries that recorded scrap',
  downtime: 'maintenance, breakdown and idle entries',
};

export default function Logbook() {
  const toast = useToast();
  const [machines, setMachines] = useState([]);
  const [selected, setSelected] = useState(null);      // machine id
  const [preset, setPreset] = useState('month');
  const [range, setRange] = useState(() => presetRange('month'));
  const [book, setBook] = useState(null);              // { machine, entries }
  const [adding, setAdding] = useState(false);
  const [employees, setEmployees] = useState([]);

  const canWrite = ['admin', 'production', 'planner'].includes(auth.user?.role);

  const loadMachines = () => api.get('/logbook/machines').then(rows => {
    setMachines(rows);
    setSelected(sel => sel ?? rows[0]?.id ?? null);
  });
  useEffect(() => { loadMachines(); api.get('/employees').then(setEmployees); }, []);

  const loadBook = () => {
    if (!selected || !range) return;
    return api.get(`/logbook/machines/${selected}?from=${range.from}&to=${range.to}`).then(setBook);
  };
  useEffect(() => { loadBook(); }, [selected, range?.from, range?.to]);
  useFallbackRefresh(loadBook, { enabled: Boolean(selected && range), intervalMs: 60000, loadOnMount: false });

  const pick = key => { setPreset(key); const r = presetRange(key); if (r) setRange(r); };

  const machine = book?.machine;
  const entries = book?.entries || [];
  const kpi = useKpiFilter(book?.machine?.id);
  const shownEntries = kpi.apply(entries, LOG_KPI_ROWS);

  const kpis = useMemo(() => ({
    runs: entries.filter(e => e.entry_type === 'production').length,
    out: entries.reduce((s, e) => s + (e.qty_out || 0), 0),
    scrap: entries.reduce((s, e) => s + (e.qty_scrap || 0), 0),
    downtime: entries.filter(e => ['maintenance', 'breakdown', 'idle'].includes(e.entry_type)).length,
  }), [entries]);

  const removeEntry = async e => {
    await api.del(`/logbook/entries/${e.entry_id}`);
    toast.success('Entry removed');
    loadBook();
  };

  const columns = [
    {
      key: 'ts', label: 'Date',
      sortValue: r => r.ts,
      render: r => <span className="whitespace-nowrap font-semibold text-slate-800">{fmt.date(r.date)}</span>,
      export: r => fmt.date(r.date),
    },
    {
      key: 'time_from', label: 'Time', sortable: false,
      render: r => (
        <div className="whitespace-nowrap tabular-nums text-slate-600">
          {timeSpan(r)}
          {duration(r) && <div className="text-[11px] text-slate-400">{duration(r)}</div>}
        </div>
      ),
      export: r => `${timeSpan(r)}${duration(r) ? ` (${duration(r)})` : ''}`,
    },
    {
      key: 'entry_type', label: 'Event',
      render: r => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${TYPE_BADGE[r.entry_type] || TYPE_BADGE.remark}`}>
          {r.entry_type === 'production' ? fmt.stage(r.stage) : fmt.title(r.entry_type)}
        </span>
      ),
      export: r => (r.entry_type === 'production' ? `Production — ${fmt.stage(r.stage)}` : fmt.title(r.entry_type)),
    },
    {
      key: 'description', label: 'Job / Description',
      render: r => (
        <div className="min-w-[180px]">
          <div className="font-semibold text-slate-800">{r.description}</div>
          {r.kind === 'auto' && (
            <div className="text-[11px] text-slate-400">{r.ref} · {r.customer_name} · PO {r.po_number}</div>
          )}
        </div>
      ),
      export: r => (r.kind === 'auto' ? `${r.description} · ${r.ref} · ${r.customer_name}` : r.description),
    },
    {
      key: 'qty_in', label: 'Qty In', align: 'right',
      render: r => <span className="tabular-nums text-slate-500">{r.qty_in != null ? fmt.num(r.qty_in) : '—'}</span>,
      export: r => (r.qty_in != null ? r.qty_in : ''),
    },
    {
      key: 'qty_out', label: 'Qty Out', align: 'right',
      render: r => <span className="font-semibold tabular-nums">{r.qty_out != null ? fmt.num(r.qty_out) : '—'}</span>,
      export: r => (r.qty_out != null ? r.qty_out : ''),
    },
    {
      key: 'qty_scrap', label: 'Scrap', align: 'right',
      render: r => <span className={`tabular-nums ${r.qty_scrap ? 'font-semibold text-red-600' : 'text-slate-400'}`}>{r.qty_scrap != null ? fmt.num(r.qty_scrap) : '—'}</span>,
      export: r => (r.qty_scrap != null ? r.qty_scrap : ''),
    },
    {
      key: 'operator', label: 'Operator',
      render: r => <span className="text-slate-600">{r.operator || '—'}</span>,
      export: r => r.operator || '',
    },
    {
      key: 'remarks', label: 'Remarks',
      render: r => (
        <span className="text-xs text-slate-500">
          {r.status === 'in_progress' && <span className="mr-1 inline-flex rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">RUNNING</span>}
          {r.status === 'partially_completed' && <span className="mr-1 inline-flex rounded-full bg-cyan-50 px-1.5 py-0.5 text-[10px] font-bold text-cyan-600">PARTIAL</span>}
          {r.status === 'hold' && <span className="mr-1 inline-flex rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">ON HOLD</span>}
          {r.remarks || (r.kind === 'manual' && r.created_by ? `by ${r.created_by}` : '')}
        </span>
      ),
      export: r => [r.status === 'in_progress' ? 'Running' : r.status === 'partially_completed' ? 'Partially done' : r.status === 'hold' ? 'On hold' : null, r.remarks].filter(Boolean).join(' · '),
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => (r.kind === 'manual' && canWrite ? (
        <button type="button" onClick={() => removeEntry(r)} title="Strike out this entry"
          className="rounded-lg p-1.5 text-slate-300 transition hover:bg-red-50 hover:text-red-500">
          <Trash2 size={14} />
        </button>
      ) : null),
    },
  ];

  const grouped = useMemo(() => {
    const g = {};
    for (const m of machines) (g[m.type] ||= []).push(m);
    // Order the sections by the process flow, not alphabetically.
    return Object.entries(g).sort(([a], [b]) => flowRank(a) - flowRank(b) || a.localeCompare(b));
  }, [machines]);

  const presetBtn = (key, label) => (
    <button key={key} type="button" onClick={() => pick(key)}
      className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${preset === key
        ? 'bg-white text-[#007AFF] shadow-[0_4px_14px_rgba(0,122,255,0.18)] ring-1 ring-white/80'
        : 'text-slate-500 hover:bg-white/60'}`}>
      {label}
    </button>
  );

  return (
    <div>
      <PageHeader title="Machine Logbook"
        subtitle="One register per machine — every run, operator and event, exportable for any timeline"
        actions={machine && canWrite && (
          <Button onClick={() => setAdding(true)}><Plus size={15} /> Log Entry</Button>
        )} />

      <div className="flex flex-col gap-5 lg:flex-row">
        {/* ── Machine rail — every machine in the master, none missed ── */}
        <aside className="w-full shrink-0 lg:w-72">
          <div className="glass overflow-hidden rounded-[22px] border border-white/70 shadow-card">
            <div className="max-h-[72vh] overflow-y-auto p-2.5">
              {grouped.map(([type, list]) => (
                <div key={type} className="mb-2.5">
                  <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-widest text-slate-400">{fmt.stage(type)}</div>
                  {list.map(m => (
                    <button key={m.id} type="button" onClick={() => setSelected(m.id)}
                      className={`mb-1 flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left transition ${selected === m.id
                        ? 'bg-white/90 shadow-[0_8px_22px_rgba(0,122,255,0.14)] ring-1 ring-white/80'
                        : 'hover:bg-white/55'} ${m.active ? '' : 'opacity-55'}`}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[m.status] || 'bg-slate-300'}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] font-bold ${selected === m.id ? 'text-[#007AFF]' : 'text-slate-800'}`}>
                          {m.name}{m.active ? '' : ' · inactive'}
                        </span>
                        <span className="block truncate text-[11px] text-slate-400">
                          {m.model || fmt.title(m.status)} · {m.last_activity ? fmt.dt(m.last_activity) : 'no logs yet'}
                        </span>
                      </span>
                      {m.runs_30d > 0 && (
                        <span className="rounded-full bg-[#E1EFFF] px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[#0064D2]">{m.runs_30d}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
              {machines.length === 0 && <div className="px-3 py-8 text-center text-sm text-slate-400">No machines in the master yet.</div>}
            </div>
          </div>
        </aside>

        {/* ── The register ── */}
        <div className="min-w-0 flex-1">
          {machine ? (
            <>
              {/* Cover block — machine identity, ISO logbook style */}
              <div className="glass mb-4 rounded-[22px] border border-white/70 p-4 shadow-card sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-black tracking-tight text-slate-900">{machine.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      Machine ID M-{String(machine.id).padStart(3, '0')} · {fmt.stage(machine.type)}
                      {machine.model ? ` · ${machine.model}` : ''}
                      {machine.capacity_per_hour ? ` · ${fmt.num(machine.capacity_per_hour)}/hr` : ''}
                    </div>
                    {machine.operators?.length > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <Users size={13} className="text-slate-400" />
                        {machine.operators.map(o => o.name).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 rounded-full bg-white/50 p-1 ring-1 ring-white/70">
                    {presetBtn('today', 'Today')}
                    {presetBtn('7d', '7 Days')}
                    {presetBtn('month', 'This Month')}
                    {presetBtn('custom', 'Custom')}
                  </div>
                </div>
                {preset === 'custom' && (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Field label="From"><Input type="date" value={range?.from || ''} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} /></Field>
                    <Field label="To"><Input type="date" value={range?.to || ''} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} /></Field>
                  </div>
                )}
              </div>

              <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
                <KpiCard label="Production Runs" value={fmt.num(kpis.runs)} icon={Layers}
                  onClick={() => kpi.toggle('runs')} active={kpi.is('runs')} />
                <KpiCard label="Qty Produced" value={fmt.num(kpis.out)} icon={NotebookPen} chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
                <KpiCard label="Scrap" value={fmt.num(kpis.scrap)} icon={AlertTriangle} chip="bg-red-50 text-red-500" accent={kpis.scrap ? 'text-red-600' : 'text-slate-900'}
                  onClick={() => kpi.toggle('scrap')} active={kpi.is('scrap')} />
                <KpiCard label="Downtime Events" value={fmt.num(kpis.downtime)} icon={Wrench} chip="bg-amber-50 text-amber-600" accent={kpis.downtime ? 'text-amber-600' : 'text-slate-900'}
                  onClick={() => kpi.toggle('downtime')} active={kpi.is('downtime')} />
              </div>
              <KpiFilterNotice filter={kpi} label={LOG_KPI_LABEL[kpi.key]}
                shown={shownEntries.length} total={entries.length} />

              <DataTable
                columns={columns}
                rows={shownEntries}
                searchable
                empty="No entries in this period — the register is blank."
                exportName={`Machine Logbook — ${machine.name}`}
                exportSubtitle={`${fmt.date(range.from)} to ${fmt.date(range.to)}`}
                exportMeta={() => [
                  `Machine: ${machine.name} (M-${String(machine.id).padStart(3, '0')})`,
                  `Section: ${fmt.stage(machine.type)}`,
                  machine.model ? `Model: ${machine.model}` : null,
                  `Period: ${fmt.date(range.from)} – ${fmt.date(range.to)}`,
                  machine.operators?.length ? `Operators: ${machine.operators.map(o => o.name).join(', ')}` : null,
                ].filter(Boolean)}
                exportSummary={() => [
                  { label: 'Production Runs', value: fmt.num(kpis.runs) },
                  { label: 'Qty Produced', value: fmt.num(kpis.out) },
                  { label: 'Scrap', value: fmt.num(kpis.scrap) },
                  { label: 'Downtime Events', value: fmt.num(kpis.downtime) },
                ]}
              />
            </>
          ) : (
            <div className="glass rounded-[22px] border border-white/70 p-14 text-center text-sm text-slate-400 shadow-card">
              <NotebookPen className="mx-auto mb-2 text-slate-300" size={26} />
              Pick a machine to open its register.
            </div>
          )}
        </div>
      </div>

      {machine && (
        <AddEntryModal open={adding} onClose={() => setAdding(false)} machine={machine}
          employees={employees}
          onSaved={() => { setAdding(false); loadBook(); loadMachines(); }} />
      )}
    </div>
  );
}

// Manual pen line — setup / maintenance / breakdown / idle / remark.
// Production runs never come from here; they flow in from the floor.
function AddEntryModal({ open, onClose, machine, employees, onSaved }) {
  const toast = useToast();
  const blank = { log_date: iso(new Date()), time_from: '', time_to: '', entry_type: 'maintenance', description: '', operator: '', qty: '', remarks: '' };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setForm(blank); }, [open, machine?.id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const crew = machine.operators?.length ? machine.operators : employees.filter(e => e.active);

  const save = async () => {
    if (!form.description.trim()) return toast.error('Describe what happened on the machine');
    setBusy(true);
    try {
      await api.post(`/logbook/machines/${machine.id}/entries`, {
        ...form,
        qty: form.qty === '' ? null : Number(form.qty),
      });
      toast.success(`Logged in ${machine.name}'s register`);
      onSaved();
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Log Entry — ${machine.name}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Add to Register'}</Button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" required><Input type="date" value={form.log_date} onChange={e => set('log_date', e.target.value)} /></Field>
        <Field label="Event Type" required>
          <Select value={form.entry_type} onChange={e => set('entry_type', e.target.value)}>
            {ENTRY_TYPES.map(t => <option key={t} value={t}>{fmt.title(t)}</option>)}
          </Select>
        </Field>
        <Field label="Time From"><Input type="time" value={form.time_from} onChange={e => set('time_from', e.target.value)} /></Field>
        <Field label="Time To"><Input type="time" value={form.time_to} onChange={e => set('time_to', e.target.value)} /></Field>
      </div>
      <Field label="Description" required hint="What happened — e.g. blanket wash, roller change, power failure">
        <Input value={form.description} onChange={e => set('description', e.target.value)} placeholder="Describe the event" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Operator">
          <Select value={form.operator} onChange={e => set('operator', e.target.value)}>
            <option value="">—</option>
            {crew.map(e => <option key={e.id} value={e.name} data-search={searchText(e)}>{e.name}</option>)}
          </Select>
        </Field>
        <Field label="Qty (if any)"><Input type="number" min="0" value={form.qty} onChange={e => set('qty', e.target.value)} placeholder="Optional" /></Field>
      </div>
      <Field label="Remarks"><Textarea value={form.remarks} onChange={e => set('remarks', e.target.value)} placeholder="Optional notes for the record" /></Field>
    </Modal>
  );
}
