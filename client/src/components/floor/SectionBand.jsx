// One production section, full width. A clear section collapses to a single row
// — the old three-column grid gave it a ~200px tile with "Section clear" in the
// middle, so a quiet shift rendered as a wall of empty cards above an equally
// empty machine grid.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmt } from '../../api.js';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SECTION_META, SORT_PASTE_META } from '../../sections.js';
import MachineBlock from './MachineBlock.jsx';
import JobRow from './JobRow.jsx';

// What a machine is actually doing, in the words the floor uses. A machine sat
// in maintenance must never be reported as idle — that is how a down press
// stays down through a quiet shift.
const LIVE_WORD = { maintenance: 'under maintenance', hold: 'held', running: 'running', idle: 'idle' };

const machineNote = machines => {
  if (!machines.length) return '';
  const idle = machines.filter(m => m.live === 'idle').length;
  if (idle === machines.length) return `${idle} machine${idle > 1 ? 's' : ''} idle`;
  return ['running', 'hold', 'maintenance', 'idle']
    .map(state => [state, machines.filter(m => m.live === state).length])
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${LIVE_WORD[state]}`)
    .join(' · ');
};

export default function SectionBand({ sec, onLog, onStatus, jobHandlers, matches = null, expanded = false, collapsible = false }) {
  const meta = sec.merged ? SORT_PASTE_META : SECTION_META[sec.section];
  const Icon = meta.icon;
  const to = sec.merged ? '/floor/sort-paste' : `/floor/${sec.section}`;
  const machines = sec.machines || [];
  const unpinned = sec.unpinned || [];
  const up = machines.filter(m => m.live === 'running').length;
  // "In queue" means work waiting to START here. Incoming is still upstream, and
  // folding it in made the bands add up to a number the page header never showed.
  const queued = sec.queued.length;
  const incoming = sec.incoming.length;
  // MachineBlock is the ONLY place anyone can open the machine log or set a
  // machine's status, so a section holds itself open while any machine is
  // anything but idle — otherwise a press under maintenance during a quiet
  // shift has no control on the page that can put it back in service.
  const attention = machines.some(m => m.live !== 'idle');
  const clear = !expanded && !attention
    && sec.running.length + (sec.held || []).length + queued + incoming === 0;

  // Touch tiers: every band starts folded to one row — the whole plant fits one
  // screen. The ROW is still the link to the station; only the chevron opens
  // the band in place to show the top jobs. An active search overrides the fold
  // (a collapsed band hiding a match would read as "no result").
  const [open, setOpen] = useState(false);
  const folded = collapsible && !open && !matches;

  if (collapsible && folded && !clear) {
    return (
      <div className="flex items-center rounded-[18px] border border-white/70 bg-white/60 shadow-card backdrop-blur-xl">
        <Link to={to} className="group flex min-w-0 flex-1 items-center gap-2.5 py-3 pl-4">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.tint}`}>
            <Icon size={15} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-extrabold text-slate-900">{meta.label}</span>
            <span className="block truncate text-[11px] text-slate-400">
              {machines.length > 0 ? `${up}/${machines.length} up` : 'bench'}
              {sec.today?.produced_today > 0 && <span className="text-emerald-600"> · {fmt.num(sec.today.produced_today)} out</span>}
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            {sec.running.length > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">{sec.running.length} running</span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${queued ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-400'}`}>
              {queued} queued
            </span>
            {incoming > 0 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{incoming} in</span>
            )}
          </span>
        </Link>
        <button type="button" aria-label={`Show top jobs at ${meta.label}`} aria-expanded={false}
          onClick={() => setOpen(true)}
          className="flex h-full min-h-[52px] w-11 shrink-0 items-center justify-center self-stretch rounded-r-[18px] text-slate-400 active:bg-white/70">
          <ChevronDown size={17} />
        </button>
      </div>
    );
  }

  if (clear) {
    return (
      <Link to={to}
        className="group flex items-center gap-2.5 rounded-[18px] border border-white/70 bg-white/50 px-4 py-3 backdrop-blur-xl transition hover:bg-white/80">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
          <Icon size={14} />
        </span>
        <span className="shrink-0 text-sm font-extrabold text-slate-400 group-hover:text-slate-700">{meta.label}</span>
        <span className="truncate text-[11px] text-slate-400">
          clear · 0 in queue{machines.length > 0 && ` · ${machineNote(machines)}`}
        </span>
        <ChevronRight size={14} className="ml-auto shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5" />
      </Link>
    );
  }

  return (
    <div className="rounded-[22px] border border-white/70 bg-white/65 shadow-card backdrop-blur-xl transition-shadow hover:shadow-lift">
      {collapsible && (
        /* Open touch band — same header, plus the fold-up control. The title
           row still navigates; only the chevron folds. */
        <div className="flex items-center">
          <Link to={to} className="group flex min-w-0 flex-1 items-center gap-2.5 py-3 pl-4">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.tint}`}>
              <Icon size={15} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-sm font-extrabold text-slate-900">
                {meta.label}
                <ChevronRight size={13} className="text-slate-300" />
              </div>
              <div className="text-[11px] text-slate-400">
                {machines.length > 0 ? `${up}/${machines.length} machines up` : 'bench section'}
                {sec.today?.completed_today > 0 && (
                  <span className="ml-1.5 text-emerald-600">· {fmt.num(sec.today.produced_today)} out today</span>
                )}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
              {sec.running.length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">{sec.running.length} running</span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${queued ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-400'}`}>
                {queued} queued
              </span>
            </div>
          </Link>
          {!matches && (
            <button type="button" aria-label={`Fold ${meta.label}`} aria-expanded
              onClick={() => setOpen(false)}
              className="flex min-h-[52px] w-11 shrink-0 items-center justify-center self-stretch text-slate-400 active:bg-white/70">
              <ChevronDown size={17} className="rotate-180" />
            </button>
          )}
        </div>
      )}
      {!collapsible && (
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
          {incoming > 0 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500"
              title="Waiting on the stage before this one — not yet this section's queue">
              {incoming} incoming
            </span>
          )}
        </div>
      </Link>
      )}

      {machines.map(m => (
        <MachineBlock key={m.id} m={m} onLog={onLog} onStatus={onStatus} jobHandlers={jobHandlers}
          showJobs={!matches} />
      ))}

      {/* Under search the band lists what actually matched, drawn from the full
          lanes — the machine and unpinned arrays arrive capped at three, so the
          fourth job in a queue matched the band but had no row to stand in. */}
      {matches && (matches.length > 0 ? (
        <div className="border-t border-slate-100 px-3 pb-3 pt-2.5">
          <div className="mb-1.5 px-1 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
            {matches.length} matching {matches.length === 1 ? 'job' : 'jobs'}
          </div>
          <div className="space-y-1.5">
            {matches.map(j => <JobRow key={j.stage_id} job={j} {...jobHandlers} />)}
          </div>
        </div>
      ) : (
        <div className="border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">
          No job here matches — this band is open because the section or a machine does.
        </div>
      ))}

      {/* The section's own queue: everything not pinned to a machine. Held jobs
          are NOT repeated here — one that started on a machine already appears
          under it, and one that never did arrives in `unpinned` anyway. */}
      {!matches && unpinned.length > 0 && (
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
