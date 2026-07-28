// One machine inside its section band: name, live state, today's output, the
// controls menu, and the jobs actually pinned to it. A machine with nothing on
// it is a single line — the old MachineCard gave an idle machine a ~180px card
// with an empty-state box in the middle of it, and there are nineteen machines.
import { ActionMenu } from '../ui.jsx';
import { fmt, auth } from '../../api.js';
import { ScrollText, Wrench, Power, CircleDot } from 'lucide-react';
import JobRow from './JobRow.jsx';

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);

export default function MachineBlock({ m, onLog, onStatus, jobHandlers }) {
  const dot = m.live === 'running' ? 'bg-amber-500 animate-pulseSoft'
    : m.live === 'hold' ? 'bg-red-500'
    : m.live === 'maintenance' ? 'bg-slate-400' : 'bg-slate-300';

  return (
    <div className="border-t border-slate-100">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate text-xs font-extrabold text-slate-900">{m.name}</span>
        <span className="truncate text-[11px] text-slate-400">
          {m.live === 'hold' ? 'on hold' : m.live}
          {m.jobs.length === 0 && ' · nothing lined up'}
          {m.today?.runs > 0 && <span className="ml-1 text-emerald-600">· {fmt.num(m.today.produced)} out today</span>}
        </span>
        {canOperate() && (
          <span className="ml-auto shrink-0">
            <ActionMenu label={`${m.name} controls`} items={[
              { label: 'View machine log', icon: ScrollText, onClick: () => onLog(m) },
              { label: 'Back in service', icon: CircleDot, onClick: () => onStatus(m, 'running') },
              { label: 'Mark idle', icon: Power, onClick: () => onStatus(m, 'idle') },
              { label: 'Under maintenance', icon: Wrench, tone: 'danger', onClick: () => onStatus(m, 'maintenance') },
            ]} />
          </span>
        )}
      </div>

      {m.jobs.length > 0 && (
        <div className="space-y-1.5 px-3 pb-3">
          {m.jobs.map(j => <JobRow key={j.stage_id} job={j} {...jobHandlers} />)}
          {m.more > 0 && (
            <div className="px-1 text-[11px] text-slate-400">+{m.more} more on this machine</div>
          )}
        </div>
      )}
    </div>
  );
}
