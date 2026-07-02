// Live Floor — every production section as a board: what's running,
// what's queued at the section, and what's still upstream. Auto-refreshes.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { Button, Field, Input, Modal, PageHeader, useToast } from '../components/ui.jsx';
import {
  Printer, Droplets, Sparkles, Stamp, Scissors, Combine, ShieldCheck,
  Play, Check, Clock3, CircleDashed, ChevronRight,
} from 'lucide-react';

const SECTION_META = {
  printing: { label: 'Printing', icon: Printer, tint: 'text-sky-600 bg-sky-50' },
  coating: { label: 'Coating', icon: Droplets, tint: 'text-cyan-600 bg-cyan-50' },
  foiling: { label: 'Foiling', icon: Sparkles, tint: 'text-amber-600 bg-amber-50' },
  embossing: { label: 'Embossing', icon: Stamp, tint: 'text-orange-600 bg-orange-50' },
  die_cutting: { label: 'Die Cutting', icon: Scissors, tint: 'text-rose-600 bg-rose-50' },
  pasting: { label: 'Pasting', icon: Combine, tint: 'text-violet-600 bg-violet-50' },
  qc: { label: 'QC', icon: ShieldCheck, tint: 'text-emerald-600 bg-emerald-50' },
};

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);

function elapsed(t) {
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function JobChip({ job, kind, onStart, onComplete }) {
  const border = kind === 'running' ? 'border-amber-300 bg-amber-50/70 ring-1 ring-amber-200'
    : kind === 'queued' ? 'border-brand-200 bg-brand-50/60'
    : 'border-slate-200 bg-slate-50/80';
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${border}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-extrabold text-slate-900">{job.jc_number}</span>
            {kind === 'running' && (
              <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />
                {elapsed(job.started_at)}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-slate-500">{job.product_name} · {job.customer_name}</div>
          <div className="mt-0.5 text-[11px] tabular-nums text-slate-600">
            {kind === 'incoming'
              ? <span className="flex items-center gap-1 text-slate-400"><CircleDashed size={11} />after {fmt.stage(job.upstream?.stage || '')}</span>
              : <>{fmt.num(job.qty_in ?? job.expected_qty)} {job.unit}{job.operator ? ` · ${job.operator}` : ''}</>}
          </div>
        </div>
        {canOperate() && kind === 'queued' && (
          <button onClick={() => onStart(job)} title="Start"
            className="btn-brand flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
            <Play size={13} />
          </button>
        )}
        {canOperate() && kind === 'running' && (
          <button onClick={() => onComplete(job)} title="Complete"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm hover:bg-amber-600">
            <Check size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function Floor() {
  const toast = useToast();
  const [sections, setSections] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0' });

  const load = () => api.get('/floor').then(setSections);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const start = async job => {
    await api.post(`/job-stages/${job.stage_id}/start`, {});
    toast.success(`${job.jc_number} started`);
    load();
  };
  const openComplete = job => {
    setCompleting(job);
    setForm({ qty_out: job.qty_in ?? '', qty_scrap: '0' });
  };
  const complete = async () => {
    await api.post(`/job-stages/${completing.stage_id}/complete`, { qty_out: +form.qty_out, qty_scrap: +form.qty_scrap });
    toast.success(`${completing.jc_number} — stage completed`);
    setCompleting(null);
    load();
  };

  if (!sections) return <div className="py-20 text-center text-sm text-slate-400">Loading the floor…</div>;

  const totalRunning = sections.reduce((s, x) => s + x.running.length, 0);
  const totalQueued = sections.reduce((s, x) => s + x.queued.length, 0);

  return (
    <div>
      <PageHeader title="Live Floor"
        subtitle={`${totalRunning} running · ${totalQueued} waiting in queues — refreshes every 10s`} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sections.map(sec => {
          const meta = SECTION_META[sec.section];
          const Icon = meta.icon;
          const busyMachines = sec.machines.filter(m => m.status === 'running').length;
          return (
            <div key={sec.section} className="flex flex-col rounded-2xl border border-slate-200/80 bg-white shadow-card transition-shadow hover:shadow-lift">
              {/* Section head — click through to the full workspace */}
              <Link to={`/floor/${sec.section}`} className="group flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${meta.tint}`}>
                    <Icon size={15} />
                  </span>
                  <div>
                    <div className="flex items-center gap-1 text-sm font-extrabold text-slate-900 group-hover:text-indigo-800">
                      {meta.label}
                      <ChevronRight size={13} className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500" />
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {sec.machines.length > 0 ? `${busyMachines}/${sec.machines.length} machines up` : 'bench section'}
                      {sec.today.completed_today > 0 && (
                        <span className="ml-1.5 text-emerald-600">· {fmt.num(sec.today.produced_today)} out today</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {sec.running.length > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                      {sec.running.length} running
                    </span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${sec.queued.length ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-400'}`}>
                    {sec.queued.length} in queue
                  </span>
                </div>
              </Link>

              {/* Queue lanes */}
              <div className="flex-1 space-y-1.5 p-3">
                {sec.running.map(j => <JobChip key={j.stage_id} job={j} kind="running" onComplete={openComplete} />)}
                {sec.queued.map(j => <JobChip key={j.stage_id} job={j} kind="queued" onStart={start} />)}
                {sec.incoming.map(j => <JobChip key={j.stage_id} job={j} kind="incoming" />)}
                {sec.running.length + sec.queued.length + sec.incoming.length === 0 && (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 py-6 text-xs text-slate-400">
                    <Clock3 size={13} /> Section clear
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `Complete ${fmt.stage(completing.stage)} — ${completing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          <Button variant="success" onClick={complete} disabled={form.qty_out === ''}>Complete Stage</Button>
        </>}>
        {completing && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {completing.product_name} · Input: <b>{fmt.num(completing.qty_in)} {completing.unit}</b>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Good output (${completing.unit})`} required>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setForm({ ...form, qty_out: e.target.value })} />
              </Field>
              <Field label={`Scrap (${completing.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
