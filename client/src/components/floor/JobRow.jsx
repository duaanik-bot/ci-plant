// One job on the Live Floor board — the facts an operator needs, and every
// control they are allowed to press, on the row itself. Replaces JobChip
// (section tiles) and MachineJobRow (machine cards), which drew the same job two
// different ways depending on which grid you happened to be looking at.
import { Link } from 'react-router-dom';
import { fmt, auth } from '../../api.js';
import {
  Play, Check, PauseCircle, ArrowUp, ArrowDown, ArrowUpRight,
  CircleDashed, AlertTriangle, PackagePlus,
} from 'lucide-react';
import { GangChip } from '../Gang.jsx';
import { TrafficLight, ReadinessPopover } from '../Readiness.jsx';
import { receivedQty } from '../../lib/received.js';

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);
// Hold/resume accepts planners too — pausing a queue is planning work as much
// as floor work, and the server's canHold agrees.
const canHold = () => ['admin', 'production', 'planner'].includes(auth.user?.role);
const canRequestSheets = () => ['admin', 'production', 'planner'].includes(auth.user?.role);

// The stages that run in sheets and can receive extra board — the server's
// SHEET_STAGES. A carton-stage shortage is an FG problem, not a board problem.
const SHEET_STAGES = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'];

// Extra sheets are accepted only against a running or held sheet stage with no
// request already open on the job card. Mirror all four conditions so the board
// never offers a button the server would 409.
export const canAskSheets = job => canRequestSheets()
  && SHEET_STAGES.includes(job.stage)
  && job.unit === 'sheets'
  && ['running', 'partial', 'hold'].includes(job.state)
  && !job.open_xs;

const jobLabel = job => job.gang_members?.length
  ? job.gang_members.map(m => m.product_name).join(' + ')
  : job.product_name;

function elapsed(t) {
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition';

export default function JobRow({ job, onStart, onComplete, onHold, onResume, onSheets, onMove }) {
  const running = job.state === 'running' || job.state === 'partial';
  const queued = job.state === 'queued' || job.state === 'incoming';
  const tone = running ? 'border-amber-200 bg-amber-50/70'
    : job.state === 'hold' ? 'border-red-200 bg-red-50/60'
    : 'border-slate-200 bg-white/60';

  const stageHref = `/floor/${job.stage === 'sorting' || job.stage === 'pasting' ? 'sort-paste' : job.stage}?q=${encodeURIComponent(job.jc_number)}`;

  return (
    <div className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${tone} ${job.gang_number ? 'border-l-[3px] !border-l-violet-400' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {/* The operator's whole question, in one dot: can I start this? Tap
              it for the nine-point checklist instead of walking to planning. */}
          {job.light && (
            <ReadinessPopover light={job.light}>
              <TrafficLight light={job.light} size="sm" />
            </ReadinessPopover>
          )}
          <span className="text-xs font-extrabold text-slate-900">{job.jc_number}</span>
          {job.gang_number && <GangChip number={job.gang_number} />}
          {running && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700">
              <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />
              {elapsed(job.started_at)}
            </span>
          )}
          {job.board_pending && (
            <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600"
              title="Board still to come — stock is short for this job's sheets">
              <AlertTriangle size={11} /> BOARD PENDING
            </span>
          )}
          {job.open_xs && (
            <span className="text-[10px] font-bold text-brand-600"
              title={`${job.open_xs} is awaiting approval — one open extra-sheet request per job`}>
              {job.open_xs}
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-slate-500" title={jobLabel(job)}>
          {jobLabel(job)}{job.gang_members?.length ? '' : ` · ${job.customer_name}`}
        </div>
        <div className="mt-0.5 truncate text-[11px] tabular-nums text-slate-600">
          {job.state === 'incoming'
            ? <span className="flex items-center gap-1 text-slate-400"><CircleDashed size={11} />after {fmt.stage(job.upstream?.stage || '')}</span>
            : job.state === 'hold'
              ? <span className="flex items-center gap-1 font-semibold text-red-600"><PauseCircle size={11} />on hold{job.hold_reason ? ` — ${job.hold_reason}` : ''}</span>
              : <>{fmt.num(receivedQty(job))} {job.unit}{job.operator ? ` · ${job.operator}` : ''}{job.machine_name ? ` · ${job.machine_name}` : ''}</>}
        </div>
      </div>

      {onMove && canOperate() && queued && (
        <>
          <button onClick={() => onMove(job, 'up')} title="Move up the queue"
            className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}>
            <ArrowUp size={13} />
          </button>
          <button onClick={() => onMove(job, 'down')} title="Move down the queue"
            className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}>
            <ArrowDown size={13} />
          </button>
        </>
      )}

      {canHold() && running && (
        <button onClick={() => onHold(job)} title="Put this job on hold"
          className={`${iconBtn} text-amber-600 hover:bg-amber-100`}>
          <PauseCircle size={13} />
        </button>
      )}

      {canAskSheets(job) && (
        <button onClick={() => onSheets(job)} title="Request extra sheets"
          className={`${iconBtn} text-slate-500 hover:bg-slate-100 hover:text-brand-700`}>
          <PackagePlus size={13} />
        </button>
      )}

      {canHold() && job.state === 'hold' && (
        <button onClick={() => onResume(job)} title="Resume"
          className={`${iconBtn} btn-brand`}>
          <Play size={13} />
        </button>
      )}

      {canOperate() && running && (
        <button onClick={() => onComplete(job)} title="Complete"
          className={`${iconBtn} bg-amber-500 text-white shadow-sm hover:bg-amber-600`}>
          <Check size={13} />
        </button>
      )}

      {canOperate() && queued && (
        <button onClick={() => onStart(job)}
          title={job.state === 'incoming'
            ? `Start ahead — ${fmt.stage(job.upstream?.stage || 'the previous stage')} hasn't finished; this stage can't be completed until it does`
            : 'Start'}
          className={`${iconBtn} ${job.state === 'queued' ? 'btn-brand' : 'border border-slate-300 bg-white text-slate-500 hover:border-brand-300 hover:text-brand-600'}`}>
          <Play size={13} />
        </button>
      )}

      <Link to={stageHref} title={`Open ${fmt.stage(job.stage)} — ${job.jc_number}`}
        className={`${iconBtn} bg-slate-100 text-slate-500 hover:bg-brand-100 hover:text-brand-700`}>
        <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}
