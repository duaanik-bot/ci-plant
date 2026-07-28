// One production section, full width. A clear section collapses to a single row
// — the old three-column grid gave it a ~200px tile with "Section clear" in the
// middle, so a quiet shift rendered as a wall of empty cards above an equally
// empty machine grid.
import { Link } from 'react-router-dom';
import { fmt } from '../../api.js';
import { ChevronRight } from 'lucide-react';
import { SECTION_META, SORT_PASTE_META } from '../../sections.js';
import MachineBlock from './MachineBlock.jsx';
import JobRow from './JobRow.jsx';

export default function SectionBand({ sec, onLog, onStatus, jobHandlers }) {
  const meta = sec.merged ? SORT_PASTE_META : SECTION_META[sec.section];
  const Icon = meta.icon;
  const to = sec.merged ? '/floor/sort-paste' : `/floor/${sec.section}`;
  const machines = sec.machines || [];
  const unpinned = sec.unpinned || [];
  const up = machines.filter(m => m.live === 'running').length;
  const queued = sec.queued.length + sec.incoming.length;
  const clear = sec.running.length + (sec.held || []).length + queued === 0;

  if (clear) {
    return (
      <Link to={to}
        className="group flex items-center gap-2.5 rounded-[18px] border border-white/70 bg-white/50 px-4 py-3 backdrop-blur-xl transition hover:bg-white/80">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
          <Icon size={14} />
        </span>
        <span className="shrink-0 text-sm font-extrabold text-slate-400 group-hover:text-slate-700">{meta.label}</span>
        <span className="truncate text-[11px] text-slate-400">
          clear · 0 in queue{machines.length > 0 && ` · ${machines.length} machine${machines.length > 1 ? 's' : ''} idle`}
        </span>
        <ChevronRight size={14} className="ml-auto shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5" />
      </Link>
    );
  }

  return (
    <div className="rounded-[22px] border border-white/70 bg-white/65 shadow-card backdrop-blur-xl transition-shadow hover:shadow-lift">
      <Link to={to} className="group flex items-center gap-2.5 px-4 py-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.tint}`}>
          <Icon size={15} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-sm font-extrabold text-slate-900 group-hover:text-indigo-800">
            {meta.label}
            <ChevronRight size={13} className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500" />
          </div>
          <div className="text-[11px] text-slate-400">
            {machines.length > 0 ? `${up}/${machines.length} machines up` : 'bench section'}
            {sec.today?.completed_today > 0 && (
              <span className="ml-1.5 text-emerald-600">· {fmt.num(sec.today.produced_today)} out today</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {sec.running.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
              {sec.running.length} running
            </span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${queued ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-400'}`}>
            {queued} in queue
          </span>
        </div>
      </Link>

      {machines.map(m => (
        <MachineBlock key={m.id} m={m} onLog={onLog} onStatus={onStatus} jobHandlers={jobHandlers} />
      ))}

      {/* The section's own queue: everything not pinned to a machine. Held jobs
          are NOT repeated here — one that started on a machine already appears
          under it, and one that never did arrives in `unpinned` anyway. */}
      {unpinned.length > 0 && (
        <div className="border-t border-slate-100 px-3 pb-3 pt-2.5">
          <div className="mb-1.5 px-1 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
            {machines.length > 0 ? 'Section queue — not yet on a machine' : 'Section queue'}
          </div>
          <div className="space-y-1.5">
            {unpinned.map(j => <JobRow key={j.stage_id} job={j} {...jobHandlers} />)}
            {sec.unpinned_more > 0 && (
              <Link to={to} className="block px-1 text-[11px] text-slate-400 hover:text-brand-700">
                +{sec.unpinned_more} more in this queue →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
