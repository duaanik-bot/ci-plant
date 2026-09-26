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
import { useState } from 'react';
import { Bot, CheckCircle2, Clock, ExternalLink, FolderOpen, Loader2, RefreshCw, Settings2, XCircle } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, useToast } from '../ui.jsx';
import { AVS_SET_GROUPS, AVS_SET_STATUS_LABEL, setGroupOf, setLabel, setProgress } from '../../lib/avs.js';
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
};
const BAR = { slate: 'bg-slate-400', sky: 'bg-sky-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', red: 'bg-red-500' };
const EMPTY = {
  active: 'Nothing in progress. Press Upload photos to send a printed sheet for checking.',
  done: 'No report from a photo set yet.',
  failed: 'No failed checks.',
  cancelled: 'Nothing cancelled.',
};

function SetProgress({ set }) {
  const p = setProgress(set);
  return (
    <div className="mt-1.5 max-w-2xl">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="min-w-0 truncate text-slate-600">
          <span className="font-semibold">{p.label}</span>
          {p.detail ? <span> · {p.detail}</span> : null}
          {p.step ? <span className="text-slate-400"> · step {p.step} of {p.steps}</span> : null}
        </span>
        <span className="shrink-0 font-mono font-semibold tabular-nums text-slate-700">{p.pct}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar"
        aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${setLabel(set.id)}: ${p.label}`}>
        <div className={`h-full rounded-full transition-[width] duration-700 ${BAR[p.tone] || BAR.slate} ${p.live ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(p.pct, 2)}%` }} />
      </div>
    </div>
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

export default function AvsSets({ data, onChanged, onOpenReport, onContinue, onSetup }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [group, setGroup] = useState('active');
  if (!data?.enabled) return null;
  const sets = data.sets || [];
  const counts = data.counts || {};
  const countOf = g => g.statuses.reduce((n, s) => n + (counts[s] ?? sets.filter(x => x.status === s).length), 0);
  const shown = sets.filter(s => setGroupOf(s.status) === group);
  const bothLinked = !!(data.linked?.drive && data.linked?.claude);
  const note = linkNote(data.linked);

  const act = async (set, verb) => {
    setBusy(`${set.id}:${verb}`);
    try {
      const out = await api.post(`/avs/uploads/${set.id}/${verb}`, {});
      if (verb === 'retry') toast.info(fireText(out.fire));
      else toast.info(`${set.label} cancelled`);
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
      {shown.length === 0 && <p className="px-1 py-2 text-sm text-slate-500">{EMPTY[group]}</p>}
      <ul className="divide-y divide-slate-100">
        {shown.map(s => {
          const Icon = ICON[s.status] || Clock;
          const kept = s.photos?.filter(p => p.stored === 'ci_plant').length || 0;
          return (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
              <div className="min-w-[16rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-700">{s.label}</span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[s.status]}`}>
                    <Icon size={11} className={s.status === 'checking' ? 'animate-spin' : ''} /> {AVS_SET_STATUS_LABEL[s.status] || s.status}
                  </span>
                  {s.result && <span className={`text-[11px] font-bold ${RESULT_TONE[s.result] || ''}`}>{s.result}</span>}
                  <span className="font-mono text-xs text-slate-600">{s.jc_number || 'no job card'}</span>
                  <span className="truncate text-sm text-slate-800">{s.product_hint || ''}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {s.photos?.length || 0} photo{s.photos?.length === 1 ? '' : 's'}
                  {kept ? ` (${kept === s.photos.length ? 'all' : kept} kept in CI Plant until filed in Drive)` : ''}
                  {' '}· {s.created_by || '—'} · {fmt.date(s.created_at)}
                  {s.status === 'queued' && s.fire_status === 'failed' && s.fire_error ? ` · ${s.fire_error}` : ''}
                  {s.status === 'queued' && s.fire_status === 'not_linked' ? ' · waits for a check started in Cowork (/avs)' : ''}
                </div>
                {setGroupOf(s.status) === 'active' && <SetProgress set={s} />}
                {s.robot_note && ['done', 'failed'].includes(s.status) && (
                  <div className={`mt-0.5 text-xs ${s.status === 'failed' ? 'text-red-700' : 'text-slate-700'}`}>{s.robot_note}</div>
                )}
                {s.note && <div className="mt-0.5 text-[11px] italic text-slate-500">“{s.note}”</div>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {s.report_no && (
                  <Button size="sm" repeatable onClick={() => onOpenReport?.(s.report_no)}>Open {s.report_no}</Button>
                )}
                {s.status === 'uploading' && (
                  <Button size="sm" variant="secondary" repeatable onClick={() => onContinue?.(s)}>Continue</Button>
                )}
                {data.can_retry && (s.status === 'failed' || (s.status === 'queued' && bothLinked)) && (
                  <Button size="sm" variant="secondary" disabled={busy === `${s.id}:retry`} onClick={() => act(s, 'retry')}>
                    <span className="inline-flex items-center gap-1"><RefreshCw size={12} /> Try again</span>
                  </Button>
                )}
                {['uploading', 'queued'].includes(s.status) && (
                  <Button size="sm" variant="ghost" disabled={busy === `${s.id}:cancel`} onClick={() => act(s, 'cancel')}>Cancel</Button>
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
    </section>
  );
}
