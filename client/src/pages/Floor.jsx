// Live Floor — every production section as a board: what's running,
// what's queued at the section, and what's still upstream. Auto-refreshes.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { ActionMenu, Button, ExportMenu, Field, Input, Modal, PageHeader, useToast } from '../components/ui.jsx';
import {
  Play, Check, Clock3, CircleDashed, ChevronRight, PauseCircle,
  ArrowUpRight, ScrollText, Wrench, Power, CircleDot, AlertTriangle,
} from 'lucide-react';
import { SECTION_META, SORT_PASTE_META } from '../sections.js';
import LineClearancePanel, { needsClearance, freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import { GangChip, GangMemberList } from '../components/Gang.jsx';

// One label for a gang parent job everywhere on the floor board — every
// member product named, in gang order, so the chip reads as one unit.
const jobLabel = job => job.gang_members?.length
  ? job.gang_members.map(m => m.product_name).join(' + ')
  : job.product_name;

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);

function elapsed(t) {
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function JobChip({ job, kind, onStart, onComplete }) {
  const border = kind === 'running' ? 'border-amber-300 bg-amber-50/70 ring-1 ring-amber-200'
    : kind === 'hold' ? 'border-red-200 bg-red-50/60'
    : kind === 'queued' ? 'border-brand-200 bg-brand-50/60'
    : 'border-slate-200 bg-slate-50/80';
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${job.gang_number ? 'border-l-[3px] !border-l-violet-400' : ''} ${border}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-extrabold text-slate-900">{job.jc_number}</span>
            {job.gang_number && <GangChip number={job.gang_number} />}
            {kind === 'running' && (
              <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />
                {elapsed(job.started_at)}
              </span>
            )}
            {job.board_pending && (kind === 'queued' || kind === 'incoming') && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600"
                title="Board still to come — stock is short for this job's sheets">
                <AlertTriangle size={11} /> BOARD PENDING
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-slate-500" title={jobLabel(job)}>
            {jobLabel(job)}{job.gang_members?.length ? '' : ` · ${job.customer_name}`}
          </div>
          <div className="mt-0.5 text-[11px] tabular-nums text-slate-600">
            {kind === 'incoming'
              ? <span className="flex items-center gap-1 text-slate-400"><CircleDashed size={11} />after {fmt.stage(job.upstream?.stage || '')}</span>
              : kind === 'hold'
                ? <span className="flex items-center gap-1 font-semibold text-red-600"><PauseCircle size={11} />on hold{job.hold_reason ? ` — ${job.hold_reason}` : ''}</span>
                : <>{fmt.num(job.qty_in ?? job.expected_qty)} {job.unit}{job.operator ? ` · ${job.operator}` : ''}</>}
          </div>
        </div>
        {canOperate() && kind === 'queued' && (
          <button onClick={() => onStart(job)} title="Start"
            className="btn-brand flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
            <Play size={13} />
          </button>
        )}
        {canOperate() && kind === 'incoming' && onStart && (
          <button onClick={() => onStart(job)}
            title={`Start ahead — ${fmt.stage(job.upstream?.stage || 'the previous stage')} hasn't finished; this stage can't be completed until it does`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 hover:border-brand-300 hover:text-brand-600">
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

// One job line on a machine card — state, JC, stage, and a jump straight
// to the section workspace pre-filtered to this job.
function MachineJobRow({ job }) {
  const dot = job.state === 'running' ? 'bg-amber-500 animate-pulseSoft'
    : job.state === 'hold' ? 'bg-red-500'
    : job.state === 'queued' ? 'bg-brand-500' : 'bg-slate-300';
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-white/60 px-2.5 py-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-extrabold text-slate-900">{job.jc_number}</span>
          {job.gang_number && <GangChip number={job.gang_number} />}
          <span className={`truncate text-[11px] font-semibold ${job.state === 'hold' ? 'text-red-600' : 'text-slate-400'}`}>
            {job.state === 'running' ? `running · ${elapsed(job.started_at)}`
              : job.state === 'hold' ? `on hold${job.hold_reason ? ` — ${job.hold_reason}` : ''}`
              : job.shared ? 'next in section queue' : job.state}
          </span>
        </div>
        <div className="truncate text-[11px] text-slate-500" title={jobLabel(job)}>
          {fmt.stage(job.stage)} · {jobLabel(job)} · {fmt.num(job.qty)} {job.unit}
          {job.operator ? ` · ${job.operator}` : ''}
        </div>
      </div>
      <Link to={`/floor/${job.stage === 'sorting' || job.stage === 'pasting' ? 'sort-paste' : job.stage}?q=${encodeURIComponent(job.jc_number)}`}
        title={`Open ${fmt.stage(job.stage)} — ${job.jc_number}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition hover:bg-brand-100 hover:text-brand-700">
        <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}

function MachineCard({ m, onLog, onStatus }) {
  const meta = SECTION_META[m.type];
  const Icon = meta?.icon || Clock3;
  const pill = m.live === 'running' ? 'bg-amber-100 text-amber-700'
    : m.live === 'hold' ? 'bg-red-100 text-red-700'
    : m.live === 'maintenance' ? 'bg-slate-200 text-slate-600'
    : 'bg-slate-100 text-slate-400';
  return (
    <div className="flex flex-col rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card transition-shadow hover:shadow-lift">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta?.tint || 'text-slate-600 bg-slate-100'}`}>
            <Icon size={15} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold text-slate-900">{m.name}</div>
            <div className="text-[11px] text-slate-400">
              {meta?.label || fmt.stage(m.type)}
              {m.today.runs > 0 && <span className="ml-1.5 text-emerald-600">· {fmt.num(m.today.produced)} out today</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${pill}`}>
            {m.live === 'running' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />}
            {m.live === 'maintenance' && <Wrench size={10} />}
            {m.live === 'hold' ? 'on hold' : m.live}
          </span>
          {canOperate() && (
            <ActionMenu label={`${m.name} controls`} items={[
              { label: 'View machine log', icon: ScrollText, onClick: () => onLog(m) },
              { label: 'Back in service', icon: CircleDot, onClick: () => onStatus(m, 'running') },
              { label: 'Mark idle', icon: Power, onClick: () => onStatus(m, 'idle') },
              { label: 'Under maintenance', icon: Wrench, tone: 'danger', onClick: () => onStatus(m, 'maintenance') },
            ]} />
          )}
        </div>
      </div>

      <div className="flex-1 space-y-1.5 p-3">
        {m.jobs.map(j => <MachineJobRow key={j.stage_id} job={j} />)}
        {m.jobs.length === 0 && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 py-5 text-xs text-slate-400">
            <Clock3 size={13} /> Nothing lined up
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2">
        <span className="text-[11px] text-slate-400">
          {m.more > 0 ? `+${m.more} more in queue`
            : m.jobs.length ? `${m.jobs.length} job${m.jobs.length > 1 ? 's' : ''} lined up` : 'machine clear'}
        </span>
        <button onClick={() => onLog(m)}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
          <ScrollText size={12} /> Log
        </button>
      </div>
    </div>
  );
}

export default function Floor() {
  const toast = useToast();
  const nav = useNavigate();
  const [sections, setSections] = useState(null);
  const [machines, setMachines] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0' });
  const [logFor, setLogFor] = useState(null);   // machine whose log is open
  const [log, setLog] = useState(null);
  const [clearing, setClearing] = useState(null);  // job awaiting line clearance before start
  const [checks, setChecks] = useState([]);

  const load = () => Promise.all([
    api.get('/floor').then(setSections),
    api.get('/floor/machines').then(setMachines),
  ]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // Line clearance stands between the button and the machine on every working
  // station (cutting → pasting) — QC starts straight away.
  const start = job => {
    if (needsClearance(job.stage)) { setClearing(job); setChecks(freshClearance()); }
    else doStart(job);
  };
  const doStart = async (job, lc) => {
    await api.post(`/job-stages/${job.stage_id}/start`, { line_clearance: lc });
    toast.success(`${job.jc_number} started`);
    setClearing(null);
    load();
  };
  const openComplete = job => {
    setCompleting(job);
    // Cutting yields child print sheets = parent in × cuts per parent; other
    // stages carry forward 1:1. Default the good output to that yield.
    const cpp = job.stage === 'cutting' ? Math.max(1, job.children_per_parent || 1) : 1;
    setForm({ qty_out: job.qty_in != null ? String(job.qty_in * cpp) : '', qty_scrap: '0' });
  };
  const complete = async () => {
    await api.post(`/job-stages/${completing.stage_id}/complete`, { qty_out: +form.qty_out, qty_scrap: +form.qty_scrap });
    toast.success(`${completing.jc_number} — stage completed`);
    setCompleting(null);
    load();
  };
  const openLog = m => {
    setLogFor(m);
    setLog(null);
    api.get(`/floor/machines/${m.id}/log`).then(setLog);
  };
  const setMachineStatus = async (m, status) => {
    await api.put(`/floor/machines/${m.id}/status`, { status });
    toast.success(`${m.name} marked ${status}`);
    load();
  };

  // Collapse Sorting + Pasting into one "Sort & Paste" board tile — the two
  // stations are now a single operator workspace. Placed where Sorting sat.
  const displaySections = useMemo(() => {
    if (!sections) return null;
    const bySec = Object.fromEntries(sections.map(s => [s.section, s]));
    const out = [];
    for (const s of sections) {
      if (s.section === 'pasting') continue;               // merged into the tile below
      if (s.section === 'sorting') {
        const p = bySec.pasting || { running: [], held: [], queued: [], incoming: [], machines: [], today: {} };
        out.push({
          section: 'sort_paste', merged: true,
          running: [...s.running, ...p.running], held: [...(s.held || []), ...(p.held || [])],
          queued: [...s.queued, ...p.queued], incoming: [...s.incoming, ...p.incoming],
          machines: [...(s.machines || []), ...(p.machines || [])],
          today: {
            completed_today: (s.today?.completed_today || 0) + (p.today?.completed_today || 0),
            produced_today: p.today?.produced_today || 0,
            scrap_today: (s.today?.scrap_today || 0) + (p.today?.scrap_today || 0),
          },
        });
        continue;
      }
      out.push(s);
    }
    return out;
  }, [sections]);

  if (!sections) return <div className="py-20 text-center text-sm text-slate-400">Loading the floor…</div>;

  const totalRunning = sections.reduce((s, x) => s + x.running.length, 0);
  const totalQueued = sections.reduce((s, x) => s + x.queued.length, 0);

  return (
    <div>
      <PageHeader title="Live Floor"
        subtitle={`${totalRunning} running · ${totalQueued} waiting in queues — refreshes every 10s`}
        actions={<ExportMenu build={() => ({
          name: 'Live Floor Snapshot',
          title: 'Live Floor Snapshot',
          subtitle: 'Plant-wide section and machine position at export time',
          summary: [
            { label: 'Running', value: totalRunning },
            { label: 'In queues', value: totalQueued },
            { label: 'Machines up', value: `${(machines || []).filter(m => m.live === 'running').length}/${(machines || []).length}` },
          ],
          sections: [
            {
              heading: 'Section Position',
              columns: [
                { key: 'section', label: 'Section', export: s => SECTION_META[s.section]?.label || s.section },
                { key: 'running', label: 'Running', align: 'right', export: s => s.running.length },
                { key: 'queued', label: 'Queued', align: 'right', export: s => s.queued.length },
                { key: 'machines', label: 'Machines Up', export: s => (s.machines.length ? `${s.machines.filter(m => m.status === 'running').length}/${s.machines.length}` : 'bench') },
                { key: 'completed_today', label: 'Completed Today', align: 'right', export: s => fmt.num(s.today?.completed_today || 0) },
                { key: 'produced_today', label: 'Produced Today', align: 'right', export: s => fmt.num(s.today?.produced_today || 0) },
                { key: 'scrap_today', label: 'Wastage Today', align: 'right', export: s => fmt.num(s.today?.scrap_today || 0) },
              ],
              rows: sections,
            },
            {
              heading: 'Machine Control',
              columns: [
                { key: 'name', label: 'Machine' },
                { key: 'type', label: 'Type', export: m => fmt.title(m.type || '') },
                { key: 'live', label: 'Status', export: m => fmt.title(m.live || m.status || '') },
                { key: 'jobs', label: 'Jobs on Machine', export: m => (m.jobs || []).map(j => j.jc_number).join(', ') || '—' },
              ],
              rows: machines || [],
            },
          ],
        })} />} />

      {/* Machine control — every machine, its live status, top jobs on it,
          jump-to-stage per job, and the machine log. */}
      {machines?.length > 0 && (
        <div className="mb-8">
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="text-sm font-extrabold tracking-[-0.01em] text-slate-900">Machine Control</h2>
            <span className="text-[11px] font-semibold text-slate-400">
              {machines.filter(m => m.live === 'running').length}/{machines.length} machines running
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {machines.map(m => (
              <MachineCard key={m.id} m={m} onLog={openLog} onStatus={setMachineStatus} />
            ))}
          </div>
        </div>
      )}

      <h2 className="mb-2.5 text-sm font-extrabold tracking-[-0.01em] text-slate-900">Sections</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {displaySections.map(sec => {
          const meta = sec.merged ? SORT_PASTE_META : SECTION_META[sec.section];
          const Icon = meta.icon;
          const busyMachines = sec.machines.filter(m => m.status === 'running').length;
          const to = sec.merged ? '/floor/sort-paste' : `/floor/${sec.section}`;
          // The merged station enforces the waste gate + hybrid grid, so its
          // chips open the station rather than the quick complete/start modals.
          const onChipStart = sec.merged ? () => nav('/floor/sort-paste') : start;
          const onChipComplete = sec.merged ? () => nav('/floor/sort-paste') : openComplete;
          return (
            <div key={sec.section} className="flex flex-col rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card transition-shadow hover:shadow-lift">
              {/* Section head — click through to the full workspace */}
              <Link to={to} className="group flex items-center justify-between border-b border-slate-100 px-4 py-3">
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
                {sec.running.map(j => <JobChip key={j.stage_id} job={j} kind="running" onComplete={onChipComplete} />)}
                {(sec.held || []).map(j => <JobChip key={j.stage_id} job={j} kind="hold" />)}
                {sec.queued.map(j => <JobChip key={j.stage_id} job={j} kind="queued" onStart={onChipStart} />)}
                {sec.incoming.map(j => <JobChip key={j.stage_id} job={j} kind="incoming" onStart={onChipStart} />)}
                {sec.running.length + (sec.held || []).length + sec.queued.length + sec.incoming.length === 0 && (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 py-6 text-xs text-slate-400">
                    <Clock3 size={13} /> Section clear
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Machine log — recent runs on this machine + full activity trail */}
      <Modal open={!!logFor} onClose={() => setLogFor(null)} wide
        title={logFor ? `${logFor.name} — Machine Log` : ''}>
        {!log ? (
          <div className="py-12 text-center text-sm text-slate-400">Loading log…</div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2 text-[11px] font-bold">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                {SECTION_META[log.machine.type]?.label || fmt.stage(log.machine.type)}
              </span>
              {log.machine.capacity_per_hour > 0 && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                  {fmt.num(log.machine.capacity_per_hour)}/hr capacity
                </span>
              )}
              <span className="rounded-full bg-slate-100 px-2.5 py-1 capitalize text-slate-600">{log.machine.status}</span>
            </div>

            <div>
              <h4 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">Recent runs</h4>
              {log.runs.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">No runs recorded on this machine yet.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="py-1.5 pr-3 font-bold">When</th>
                      <th className="py-1.5 pr-3 font-bold">Job</th>
                      <th className="py-1.5 pr-3 font-bold">Stage</th>
                      <th className="py-1.5 pr-3 font-bold">In → Out</th>
                      <th className="py-1.5 pr-3 font-bold">Scrap</th>
                      <th className="py-1.5 pr-3 font-bold">Yield</th>
                      <th className="py-1.5 font-bold">Operator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.runs.map(rn => (
                      <tr key={rn.id} className="border-t border-slate-100">
                        <td className="py-2 pr-3 tabular-nums text-slate-500">{fmt.dt(rn.completed_at ?? rn.started_at)}</td>
                        <td className="py-2 pr-3">
                          <span className="font-bold text-slate-900">{rn.jc_number}</span>
                          <div className="max-w-[200px] truncate text-slate-400">{rn.product_name}</div>
                        </td>
                        <td className="py-2 pr-3">{fmt.stage(rn.stage)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {rn.status === 'completed' ? `${fmt.num(rn.qty_in)} → ${fmt.num(rn.qty_out)}`
                            : rn.status === 'in_progress' ? <span className="font-semibold text-amber-700">{fmt.num(rn.qty_in)} running</span>
                            : rn.status === 'hold' ? <span className="font-semibold text-red-600">on hold</span>
                            : '—'} {rn.status === 'completed' ? rn.unit : ''}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{rn.status === 'completed' ? fmt.num(rn.qty_scrap) : '—'}</td>
                        <td className="py-2 pr-3 tabular-nums">{rn.yield_pct != null ? `${rn.yield_pct}%` : '—'}</td>
                        <td className="py-2">{rn.operator || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">Activity trail</h4>
              {log.audit.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">No activity recorded yet.</p>
              ) : (
                <ol className="relative ml-2 border-l-2 border-slate-100">
                  {log.audit.map(a => (
                    <li key={a.id} className="relative pb-4 pl-5 last:pb-0">
                      <span className={`absolute -left-[5px] top-1.5 h-2 w-2 rounded-full ${
                        a.action === 'start' ? 'bg-amber-400'
                          : a.action === 'complete' ? 'bg-emerald-500'
                          : a.entity === 'machine' ? 'bg-brand-400' : 'bg-slate-300'}`} />
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-sm">
                          <b className="font-bold text-slate-900">{a.jc_number || logFor?.name}</b>
                          <span className="ml-2 font-semibold capitalize text-slate-600">{a.action.replace(/:/g, ' → ')}</span>
                          {a.stage && <span className="ml-2 text-xs text-slate-400">{fmt.stage(a.stage)}</span>}
                          {a.detail && <span className="ml-2 text-xs text-slate-400">{a.detail}</span>}
                        </span>
                        <span className="text-[11px] tabular-nums text-slate-400">
                          {fmt.dt(a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `Complete ${fmt.stage(completing.stage)} — ${completing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          <Button variant="success" onClick={complete} disabled={form.qty_out === ''}>Complete Stage</Button>
        </>}>
        {completing && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {completing.gang_number
                ? <span className="font-semibold text-violet-700">{completing.gang_number} — one combined count</span>
                : completing.product_name} · Input: <b>{fmt.num(completing.qty_in)} {completing.unit}</b>
              {completing.gang_members?.length > 0 && <GangMemberList members={completing.gang_members} className="mt-2" />}
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

      {/* Line clearance before a quick start from the floor board */}
      <Modal open={!!clearing} onClose={() => setClearing(null)}
        title={clearing ? `Line Clearance — ${clearing.jc_number} · ${fmt.stage(clearing.stage)}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setClearing(null)}>Cancel</Button>
          <Button onClick={() => doStart(clearing, clearancePayload(checks))} disabled={!allClear(checks)}>
            <Play size={13} /> Start Run
          </Button>
        </>}>
        {clearing && (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              {clearing.gang_number
                ? <span className="font-semibold text-violet-700">{clearing.gang_number} — {jobLabel(clearing)}</span>
                : clearing.product_name} · Expected input: <b>{fmt.num(clearing.expected_qty)} {clearing.unit}</b>
            </div>
            <LineClearancePanel checks={checks} onChange={setChecks} />
          </div>
        )}
      </Modal>
    </div>
  );
}
