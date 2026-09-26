// Photo sets on the Artwork Verification page — each upload and where it stands:
// adding photos → waiting for Claude → Claude is checking (with its progress) →
// report ready | check failed. Refreshed every 10 seconds while one is under way.
import { useState } from 'react';
import { Bot, CheckCircle2, Clock, ExternalLink, FolderOpen, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, useToast } from '../ui.jsx';
import { AVS_SET_STATUS_LABEL } from '../../lib/avs.js';
import { fireText } from './AvsUpload.jsx';

const TONE = {
  uploading: 'bg-slate-100 text-slate-600', queued: 'bg-sky-50 text-sky-700', checking: 'bg-violet-50 text-violet-700',
  done: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700', cancelled: 'bg-slate-100 text-slate-400',
};
const ICON = { uploading: Clock, queued: Clock, checking: Loader2, done: CheckCircle2, failed: XCircle, cancelled: XCircle };
const RESULT_TONE = { PASS: 'text-emerald-700', HOLD: 'text-amber-700', REJECT: 'text-red-700' };

export default function AvsSets({ data, onChanged, onOpenReport, onContinue }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const sets = data?.sets || [];
  if (!data?.enabled) return null;

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
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Photo sets sent for checking</h2>
        <span className="flex items-center gap-2 text-[11px]">
          <span className={data.linked?.drive ? 'text-emerald-600' : 'text-slate-400'}>Drive {data.linked?.drive ? 'linked' : 'not linked'}</span>
          <span className={data.linked?.claude ? 'text-emerald-600' : 'text-slate-400'}>· Claude {data.linked?.claude ? 'linked' : 'not linked'}</span>
        </span>
      </div>
      {sets.length === 0 && <p className="px-1 py-2 text-sm text-slate-500">No photos uploaded yet. Press Upload photos to send a printed sheet for checking.</p>}
      <ul className="divide-y divide-slate-100">
        {sets.slice(0, 12).map(s => {
          const Icon = ICON[s.status] || Clock;
          return (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
              <div className="min-w-0 flex-1">
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
                  {s.photos?.length || 0} photo{s.photos?.length === 1 ? '' : 's'} · {s.created_by || '—'} · {fmt.date(s.created_at)}
                  {s.status === 'checking' && s.progress ? ` · ${s.progress}` : ''}
                  {s.status === 'queued' && s.fire_status === 'failed' && s.fire_error ? ` · ${s.fire_error}` : ''}
                  {s.status === 'queued' && s.fire_status === 'not_linked' ? ' · Claude is not linked yet' : ''}
                </div>
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
                {['queued', 'failed'].includes(s.status) && data.can_retry && (
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
