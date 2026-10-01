// Photo sets on the Artwork Verification page, one status group at a time:
// chips for In progress, Report ready, Check failed and Cancelled, each with its
// count. A set leaves In progress for its chip the moment it is done.
//
// A set in progress shows a bar: adding photos → waiting for Claude → the
// check's steps as Claude writes them (lib/avs.js setProgress) → report ready.
// Refreshed every 10 seconds while one is waiting or being checked.
//
// Photos taken while the Drive link is not set up are kept in CI Plant until the
// check files them in the AVS folder; the note under the chips says so plainly.
//
// Report ready shows one row per report — the newest check. Redo verification
// on it starts a new set for the same job card; when that check is done, the
// row moves to it and the earlier sets fold under "Earlier checks".
//
// Every set shows its total time underneath (from Verify to the report, split
// into waiting for Claude and checking; live while in progress), and a click on
// a set (or "Steps") opens its steps with a green tick for each one finished,
// a spinner on the step running now, and how long each took (owner's request,
// 1 Oct 2026; lib/avs.js totalTime, stepChecklist).
//
// Cancel works at any stage before the report — also while Claude is checking
// (it is stopped). Any set without a report can be deleted, and "Delete and
// redo" starts a new set with the same photos; a set that made a report is
// deleted with its report. Deleted sets are under the Deleted chip, with who,
// when and why (owner's request, 1 Oct 2026; components/avs/AvsStop.jsx).
//
// The finished groups show one time window (Today, 7 days, 30 days, All; by
// when the set ended) and the first few rows, with "Show all" for the rest, so
// the list never pushes the register off the page.
import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock, ExternalLink, FolderOpen, History, Loader2, RefreshCw, RotateCcw, Settings2, Square, Timer, Trash2, XCircle } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, useToast } from '../ui.jsx';
import {
  AVS_CANCELLABLE, AVS_PERIOD_DEFAULT, AVS_PERIODS, AVS_SET_GROUPS, AVS_SET_STATUS_LABEL, AVS_SETS_SHOWN, foldEarlierChecks, inPeriod, setDeletable,
  elapsedText, istStamp, reportLabel, setClock, setEndedAt, setGroupOf, setLabel, setProgress, stepChecklist, totalTime,
} from '../../lib/avs.js';
import { fireText } from './AvsUpload.jsx';

const TONE = {
  uploading: 'bg-slate-100 text-slate-600', queued: 'bg-sky-50 text-sky-700', checking: 'bg-violet-50 text-violet-700',
  done: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700', cancelled: 'bg-slate-100 text-slate-400',
};
const ICON = { uploading: Clock, queued: Clock, checking: Loader2, done: CheckCircle2, failed: XCircle, cancelled: XCircle };
const RESULT_TONE = { PASS: 'text-emerald-700', HOLD: 'text-amber-700', REJECT: 'text-red-700' };
const CHIP_ON = {
  active: 'bg-violet-600 text-white ring-violet-600', done: 'bg-emerald-600 text-white ring-emerald-600',
  failed: 'bg-red-600 text-white ring-red-600', cancelled: 'bg-slate-600 text-white ring-slate-600',
  deleted: 'bg-slate-800 text-white ring-slate-800',
};
const BAR = {
  slate: 'bg-slate-400', sky: 'bg-sky-500', amber: 'bg-amber-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', red: 'bg-red-500',
};

// Ticks every second while a set waits or is being checked, for the clocks.
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
const EMPTY = {
  active: 'Nothing in progress. Press Upload photos to send a printed sheet for checking.',
  done: 'No report from a photo set yet.',
  failed: 'No failed checks.',
  cancelled: 'Nothing cancelled.',
  deleted: 'Nothing deleted.',
};

function SetProgress({ set, now }) {
  const p = setProgress(set);
  const clock = setClock(set, now);
  return (
    <div className="mt-1.5 max-w-2xl">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="min-w-0 truncate text-slate-600">
          <span className="font-semibold">{p.label}</span>
          {p.detail ? <span> · {p.detail}</span> : null}
          {p.step ? <span className="text-slate-400"> · step {p.step} of {p.steps}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-3 tabular-nums">
          {clock && (
            <span className="inline-flex items-center gap-1 text-slate-500" title={`${clock.label} ${clock.text}`}>
              <Timer size={12} className={clock.live ? 'text-violet-500' : ''} /> {clock.text}
            </span>
          )}
          <span className="font-mono font-semibold text-slate-700">{p.pct}%</span>
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar"
        aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${setLabel(set.id)}: ${p.label}`}>
        <div className={`h-full rounded-full transition-[width] duration-700 ${BAR[p.tone] || BAR.slate} ${p.live ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(p.pct, 2)}%` }} />
      </div>
    </div>
  );
}

// Total time to process the verification, under the set: from Verify to the
// report, with the wait for Claude and the check itself. Live while in progress.
export function TotalTime({ set, now, compact = false }) {
  const t = totalTime(set, now);
  if (!t) return null;
  return (
    <div className={`mt-1.5 inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2.5 py-1 text-[11px] ring-1 ${t.live
      ? 'bg-violet-50 text-violet-900 ring-violet-200' : 'bg-slate-50 text-slate-700 ring-slate-200'}`}>
      <span className="inline-flex items-center gap-1 font-semibold">
        <Timer size={12} className={t.live ? 'text-violet-500' : 'text-slate-500'} />
        {t.live ? 'Total so far' : 'Total time to verify'}: <span className="tabular-nums">{elapsedText(t.totalMs)}</span>
      </span>
      {!compact && <span className="tabular-nums text-slate-500">waiting for Claude {elapsedText(t.waitMs)}</span>}
      {!compact && t.checkMs != null && <span className="tabular-nums text-slate-500">checking {elapsedText(t.checkMs)}</span>}
    </div>
  );
}

const STEP_ICON = {
  done: <CheckCircle2 size={15} className="text-emerald-600" aria-label="done" />,
  current: <Loader2 size={15} className="animate-spin text-violet-600" aria-label="running now" />,
  failed: <XCircle size={15} className="text-red-600" aria-label="failed" />,
  pending: <Circle size={15} className="text-slate-300" aria-label="not started" />,
};

// The set's steps: a green tick for each one finished, the one running now,
// and how long each took.
export function StepList({ set, now }) {
  const rows = stepChecklist(set, now);
  return (
    <ol className="mt-2 max-w-2xl space-y-0.5 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200" aria-label={`${setLabel(set.id)}: steps`}>
      {rows.map(r => (
        <li key={r.key} className="flex items-center justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            {STEP_ICON[r.state]}
            <span className={r.state === 'pending' ? 'text-slate-400' : r.state === 'current' ? 'font-semibold text-violet-800'
              : r.state === 'failed' ? 'font-semibold text-red-700' : 'text-slate-700'}>{r.label}</span>
            {r.state === 'current' && <span className="rounded-full bg-violet-100 px-1.5 text-[10px] font-semibold text-violet-700">now</span>}
          </span>
          <span className="shrink-0 tabular-nums text-[11px] text-slate-500">{r.ms != null ? elapsedText(r.ms) : ''}</span>
        </li>
      ))}
    </ol>
  );
}

// What the two links mean for the people using the page, in one sentence.
function linkNote(linked) {
  const drive = !!linked?.drive;
  const claude = !!linked?.claude;
  if (drive && claude) return null;
  if (!drive && !claude) {
    return 'Google Drive and Claude are not linked yet. Uploads still work: CI Plant keeps the photos safely, and a check is started from Cowork (/avs), which files them in the AVS folder.';
  }
  if (!drive) return 'Google Drive is not linked yet: CI Plant keeps the photos, and checks start from Cowork (/avs) until it is.';
  return 'Claude is not linked yet: sets wait in the queue until a check is started from Cowork (/avs).';
}

export default function AvsSets({ data, onChanged, onOpenReport, onContinue, onSetup, onRedo, onCancel, onDelete, onDeleteReport }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [group, setGroup] = useState('active');
  const [period, setPeriod] = useState(AVS_PERIOD_DEFAULT);
  const [showAll, setShowAll] = useState(false);
  const [openSteps, setOpenSteps] = useState(() => new Set());
  const toggleSteps = id => setOpenSteps(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  useEffect(() => { setShowAll(false); }, [group, period]);
  const now = useNow((data?.sets || []).some(s => s.status === 'queued' || s.status === 'checking'));
  if (!data?.enabled) return null;
  const sets = data.sets || [];
  const counts = data.counts || {};
  const countOf = g => g.statuses.reduce((n, s) => n + (counts[s] ?? sets.filter(x => x.status === s).length), 0);
  const inGroup = group === 'deleted' ? (data.deleted || []) : sets.filter(s => setGroupOf(s.status) === group);
  const folded = group === 'done' ? foldEarlierChecks(inGroup) : inGroup;
  const finished = group !== 'active';
  const inWindow = finished ? folded.filter(s => inPeriod(group === 'deleted' ? s.deleted_at : setEndedAt(s), period)) : folded;
  const shown = showAll ? inWindow : inWindow.slice(0, AVS_SETS_SHOWN);
  const hidden = inWindow.length - shown.length;
  // A report being checked again: its redo set, so the row says so instead of offering Redo twice.
  const openRedo = no => sets.find(x => x.redo_report_no === no && ['uploading', 'queued', 'checking'].includes(x.status));
  const bothLinked = !!(data.linked?.drive && data.linked?.claude);
  const note = linkNote(data.linked);

  const act = async (set, verb) => {
    setBusy(`${set.id}:${verb}`);
    try {
      const out = await api.post(`/avs/uploads/${set.id}/${verb}`, {});
      if (verb === 'retry') toast.info(fireText(out.fire));
      onChanged?.();
    } catch { /* api.js said why */ } finally { setBusy(null); }
  };

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">Photo sets</h2>
          {AVS_SET_GROUPS.map(g => {
            const n = countOf(g);
            const on = group === g.key;
            const alert = g.key === 'failed' && n > 0 && !on;
            return (
              <button key={g.key} type="button" onClick={() => setGroup(g.key)} aria-pressed={on}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 transition ${on ? CHIP_ON[g.key] : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}`}>
                {g.label}
                <span className={`min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] tabular-nums ${on ? 'bg-white/25' : alert ? 'bg-red-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{n}</span>
              </button>
            );
          })}
        </div>
        <span className="flex items-center gap-2 text-[11px]">
          <span className={data.linked?.drive ? 'text-emerald-600' : 'text-slate-500'}>Google Drive {data.linked?.drive ? 'linked' : 'not linked'}</span>
          <span className={data.linked?.claude ? 'text-emerald-600' : 'text-slate-500'}>· Claude {data.linked?.claude ? 'linked' : 'not linked'}</span>
        </span>
      </div>
      {note && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span>{note}</span>
          {data.is_admin && onSetup && (
            <Button size="sm" variant="secondary" repeatable onClick={onSetup}>
              <span className="inline-flex items-center gap-1"><Settings2 size={12} /> Set up the links</span>
            </Button>
          )}
        </div>
      )}
      {finished && (
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-slate-400">Show</span>
          {AVS_PERIODS.map(p => (
            <button key={p.key} type="button" onClick={() => setPeriod(p.key)} aria-pressed={period === p.key}
              className={`rounded-full px-2.5 py-0.5 font-semibold ring-1 transition ${period === p.key
                ? 'bg-slate-800 text-white ring-slate-800' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}`}>
              {p.label}
            </button>
          ))}
          <span className="ml-1 text-slate-400">
            {inWindow.length} of {folded.length}{group === 'done' ? ' reports' : ' sets'} loaded
          </span>
        </div>
      )}
      {shown.length === 0 && (
        <p className="px-1 py-2 text-sm text-slate-500">
          {finished && folded.length ? `Nothing in this time window. Pick a longer one to see older ${group === 'done' ? 'reports' : 'sets'}.` : EMPTY[group]}
        </p>
      )}
      <ul className="divide-y divide-slate-100">
        {shown.map(s => {
          const Icon = ICON[s.status] || Clock;
          const kept = s.photos?.filter(p => p.stored === 'ci_plant').length || 0;
          const took = ['done', 'failed'].includes(s.status) ? setClock(s) : null;
          return (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
              <div className="min-w-[16rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-700">{s.label}</span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[s.status]}`}>
                    <Icon size={11} className={s.status === 'checking' ? 'animate-spin' : ''} /> {AVS_SET_STATUS_LABEL[s.status] || s.status}
                  </span>
                  {s.result && <span className={`text-[11px] font-bold ${RESULT_TONE[s.result] || ''}`}>{s.result}</span>}
                  {s.report_no && s.status === 'done' && (
                    <span className="font-mono text-[11px] text-slate-500">{reportLabel({ report_no: s.report_no, check_no: s.check_no ?? 1, report_rev: s.report_rev ?? 0 })}</span>
                  )}
                  {s.redo_report_no && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200">
                      <History size={11} /> Redo of {s.redo_report_no}
                    </span>
                  )}
                  <span className="font-mono text-xs text-slate-600">
                    {(Array.isArray(s.job_cards) && s.job_cards.length > 1 ? s.job_cards.map(c => c.jc_number).join(', ') : s.jc_number) || 'no job card'}
                  </span>
                  <span className="truncate text-sm text-slate-800">{s.product_hint || ''}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {s.photos?.length || 0} photo{s.photos?.length === 1 ? '' : 's'}
                  {kept ? ` (${kept === s.photos.length ? 'all' : kept} kept in CI Plant until filed in Drive)` : ''}
                  {' '}· {s.created_by || '—'} · uploaded {istStamp(s.created_at) || fmt.date(s.created_at)}
                  {s.finished_at && ['done', 'failed'].includes(s.status) ? ` · finished ${istStamp(s.finished_at)}` : ''}
                  {s.status === 'cancelled' && s.cancelled_at ? ` · cancelled ${istStamp(s.cancelled_at)}${s.cancelled_by ? ` by ${s.cancelled_by}` : ''}`
                    + `${s.cancelled_status === 'checking' ? ' while Claude was checking' : ''}` : ''}
                  {took ? ` · ${took.label} ${took.text}` : ''}
                  {s.status === 'queued' && s.fire_status === 'failed' && s.fire_error ? ` · ${s.fire_error}` : ''}
                </div>
                {setGroupOf(s.status) === 'active' && (
                  <div role="button" tabIndex={0} onClick={() => toggleSteps(s.id)} aria-expanded={openSteps.has(s.id)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSteps(s.id); } }}
                    title="Click to see where this check is, step by step"
                    className="w-full max-w-2xl cursor-pointer rounded-lg hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
                    <SetProgress set={s} now={now} />
                  </div>
                )}
                {s.status !== 'cancelled' && s.status !== 'uploading' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <TotalTime set={s} now={now} />
                    <button type="button" onClick={() => toggleSteps(s.id)} aria-expanded={openSteps.has(s.id)}
                      className="mt-1.5 inline-flex items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-50">
                      {openSteps.has(s.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Steps
                    </button>
                  </div>
                )}
                {openSteps.has(s.id) && <StepList set={s} now={now} />}
                {s.robot_note && ['done', 'failed'].includes(s.status) && (
                  <div className={`mt-0.5 text-xs ${s.status === 'failed' ? 'text-red-700' : 'text-slate-700'}`}>{s.robot_note}</div>
                )}
                {s.redo_reason && <div className="mt-0.5 text-[11px] text-violet-800">Why redone: {s.redo_reason}</div>}
                {s.cancel_reason && !s.deleted_at && <div className="mt-0.5 text-[11px] text-amber-800">Why cancelled: {s.cancel_reason}</div>}
                {s.deleted_at && (
                  <div className="mt-0.5 text-[11px] text-red-700">
                    Deleted {istStamp(s.deleted_at)}{s.deleted_by ? ` by ${s.deleted_by}` : ''}: {s.delete_reason}
                  </div>
                )}
                {(s.replaces_report_no || s.replaces_set_id) && (
                  <div className="mt-0.5 text-[11px] text-violet-800">
                    Redo of deleted {s.replaces_report_no || setLabel(s.replaces_set_id)} — gets a new report number
                  </div>
                )}
                {s.note && <div className="mt-0.5 text-[11px] italic text-slate-500">“{s.note}”</div>}
                {s.earlier?.length > 0 && (
                  <div className="mt-1 text-[11px] text-slate-500">
                    Earlier checks (kept on record):{' '}
                    {s.earlier.map((x, i) => (
                      <span key={x.id}>{i ? ' · ' : ''}{x.label}
                        {x.check_no ? ` Check ${x.check_no}` : ''}{x.result ? ` ${x.result}` : ''}{x.finished_at ? ` · ${istStamp(x.finished_at)}` : ''}</span>
                    ))}
                  </div>
                )}
                {s.status === 'done' && s.report_no && openRedo(s.report_no) && (
                  <div className="mt-1 text-[11px] font-semibold text-violet-700">
                    Being checked again: {openRedo(s.report_no).label} ({AVS_SET_STATUS_LABEL[openRedo(s.report_no).status]}) — under In progress.
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {s.report_no && !s.deleted_at && (
                  <Button size="sm" repeatable onClick={() => onOpenReport?.(s.report_no)}>Open {s.report_no}</Button>
                )}
                {s.status === 'uploading' && !s.deleted_at && (
                  <Button size="sm" variant="secondary" repeatable onClick={() => onContinue?.(s)}>Continue</Button>
                )}
                {data.can_upload && onRedo && s.status === 'done' && s.report_no && !openRedo(s.report_no) && (
                  <Button size="sm" variant="secondary" repeatable onClick={() => onRedo(s)}
                    title="Upload new photos and check this product again. The current report stays on record.">
                    <span className="inline-flex items-center gap-1"><RotateCcw size={12} /> Redo verification</span>
                  </Button>
                )}
                {data.can_retry && !s.deleted_at && (s.status === 'failed' || (s.status === 'queued' && bothLinked)) && (
                  <Button size="sm" variant="secondary" disabled={busy === `${s.id}:retry`} onClick={() => act(s, 'retry')}>
                    <span className="inline-flex items-center gap-1"><RefreshCw size={12} /> Try again</span>
                  </Button>
                )}
                {data.can_upload && onCancel && !s.deleted_at && AVS_CANCELLABLE.includes(s.status) && (
                  <Button size="sm" variant="ghost" repeatable onClick={() => onCancel(s)}
                    title={s.status === 'checking' ? 'Stop Claude\'s check on this set' : 'Cancel this set'}>
                    <span className="inline-flex items-center gap-1"><Square size={11} /> {s.status === 'checking' ? 'Stop' : 'Cancel'}</span>
                  </Button>
                )}
                {data.can_delete && onDelete && setDeletable(s) && s.status !== 'uploading' && (
                  <Button size="sm" variant="ghost" repeatable onClick={() => onDelete(s)}
                    title="Delete this check (kept on record) and, if you like, redo it with the same photos">
                    <span className="inline-flex items-center gap-1 text-red-700"><Trash2 size={12} /> Delete{s.status === 'failed' || s.status === 'cancelled' ? ' / redo' : ''}</span>
                  </Button>
                )}
                {data.can_delete && onDeleteReport && s.status === 'done' && s.report_no && !s.deleted_at && (
                  <Button size="sm" variant="ghost" repeatable onClick={() => onDeleteReport({
                    report_no: s.report_no, product_name: s.product_hint, status: s.result, job_card: s.jc_number,
                    check_no: s.check_no ?? 1, report_rev: s.report_rev ?? 0,
                  })} title="Delete this report and its whole verification (kept on record), then redo it">
                    <span className="inline-flex items-center gap-1 text-red-700"><Trash2 size={12} /> Delete report</span>
                  </Button>
                )}
                {s.drive_folder_url && (
                  <a href={s.drive_folder_url} target="_blank" rel="noreferrer" title="Photos in Google Drive"
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">
                    <FolderOpen size={13} /> Drive
                  </a>
                )}
                {s.session_url && data.is_admin && (
                  <a href={s.session_url} target="_blank" rel="noreferrer" title="Claude's session for this check"
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">
                    <Bot size={13} /> Claude <ExternalLink size={11} />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || (showAll && inWindow.length > AVS_SETS_SHOWN)) && (
        <div className="mt-1 border-t border-slate-100 pt-2 text-center">
          <Button size="sm" variant="ghost" repeatable onClick={() => setShowAll(v => !v)}>
            {showAll ? `Show the first ${AVS_SETS_SHOWN} only` : `Show all ${inWindow.length} (${hidden} more)`}
          </Button>
        </div>
      )}
    </section>
  );
}
