// A bulk costing's road to the customer's mail, as AVS shows a photo check: a bar, each stage with a green tick and
// its time, the stage running now, the total time — and the one button the person needs next (owner, 11 Nov 2026).
import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, ExternalLink, Loader2, Mail, Timer, XCircle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, useToast } from '../../components/ui.jsx';
import { quoteProgress } from '../../lib/quoteProgress.js';
import { elapsedText } from '../../lib/avs.js';
import { quoteAndDraft, sendSummary } from '../../lib/quoteFlow.js';

const ICON = {
  done: <CheckCircle2 size={15} className="text-emerald-600" aria-label="done" />,
  current: <Loader2 size={15} className="animate-spin text-violet-600" aria-label="now" />,
  failed: <XCircle size={15} className="text-red-600" aria-label="failed" />,
  pending: <Circle size={15} className="text-slate-300" aria-label="not yet" />,
};
const when = iso => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function QuoteProgress({ batchId, canFinalise = false, reloadSignal = 0 }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/costing/batches/${batchId}/progress`).then(setData).catch(() => {});
  useEffect(() => { if (batchId) load(); }, [batchId, reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = data ? quoteProgress(data, now) : null;
  // While a stage is open: the clock ticks every second, and the stages are read again every 10 seconds.
  useEffect(() => {
    if (!p?.live) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(load, 10000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [p?.live, batchId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p || !p.stages[0].of) return null;

  const act = async fn => { setBusy(true); try { await fn(); await load(); } finally { setBusy(false); } };
  // One press: the quotation (the approved template — product, details asked, rate) and its Gmail draft job.
  // (Named sendNow: a handler called quoteAndDraft shadowed the import and called itself forever — 11 Nov 2026.)
  const sendNow = () => act(async () => {
    const r = await quoteAndDraft(api, p.to_quote);
    if (r.failed.length) toast.error(r.failed.join('; '));
    (r.drafted.length ? toast.success : toast.info)(sendSummary(r));
  });
  const draftAgain = () => act(async () => {
    for (const qt of p.quotations.filter(x => ['ready', 'drafted'].includes(x.status))) await api.post(`/costing/quotations/${qt.id}/draft`, {});
    toast.success('Sent to Claude for the Gmail draft');
  });
  const live = p.live;
  const bar = p.complete ? 'bg-emerald-500' : p.next?.kind === 'failed' ? 'bg-red-500' : 'bg-violet-500';

  return (
    <section className="glass mb-4 rounded-2xl p-4" aria-label="Progress to the customer's mail">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="text-sm font-bold text-[#1D1D1F]">{p.complete ? 'Done — sent to the customer' : `Now: ${p.stages.find(s => s.key === p.current)?.label}`}</div>
        <span className={`ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold ring-1 ${live ? 'bg-violet-50 text-violet-900 ring-violet-200' : 'bg-emerald-50 text-emerald-900 ring-emerald-200'}`}>
          <Timer size={12} className={live ? 'text-violet-500' : 'text-emerald-600'} />
          {live ? 'Total so far' : 'Total time'}: <span className="tabular-nums">{elapsedText(p.total_ms)}</span>
        </span>
        <span className="font-mono text-sm font-semibold text-slate-700">{p.pct}%</span>
      </div>
      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-[width] duration-700 ${bar} ${live ? 'animate-pulse' : ''}`} style={{ width: `${Math.max(p.pct, 2)}%` }} />
      </div>
      <ol className="mt-3 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
        {p.stages.map(s => (
          <li key={s.key} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-2">
              {ICON[s.state]}
              <span className={s.state === 'pending' ? 'text-slate-400' : s.state === 'current' ? 'font-semibold text-violet-800' : s.state === 'failed' ? 'font-semibold text-red-700' : 'text-slate-700'}>{s.label}</span>
              {s.of > 1 && s.state !== 'done' && s.done > 0 && <span className="text-[10px] text-slate-500">{s.done}/{s.of}</span>}
              {s.state === 'current' && <span className="rounded-full bg-violet-100 px-1.5 text-[10px] font-semibold text-violet-700">now</span>}
            </span>
            <span className="shrink-0 tabular-nums text-[11px] text-slate-500" title={s.at ? when(s.at) : ''}>
              {s.at ? when(s.at) : ''}{s.ms != null ? ` · ${elapsedText(s.ms)}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {p.next && (
        <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs ring-1 ${p.next.kind === 'failed' ? 'bg-red-50 text-red-900 ring-red-200' : p.next.kind === 'wait' ? 'bg-violet-50 text-violet-900 ring-violet-200' : 'bg-amber-50 text-amber-900 ring-amber-200'}`}>
          <span className="min-w-0 flex-1 font-semibold">{p.next.kind === 'wait' ? '' : 'Next: '}{p.next.text}</span>
          {p.next.kind === 'quote' && canFinalise && p.to_quote.length > 0 && (
            <Button size="sm" onClick={sendNow} disabled={busy}><Mail size={13} className="mr-1 inline" />Make quotation & Gmail draft</Button>
          )}
          {(p.next.kind === 'draft' || p.next.kind === 'failed') && <Button size="sm" onClick={draftAgain} disabled={busy}><Mail size={13} className="mr-1 inline" />Save as Gmail draft</Button>}
          {p.quotations.filter(x => x.draft_url).map(x => (
            <a key={x.id} href={x.draft_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-bold text-brand-700 hover:underline">
              Open {x.quotation_no} draft <ExternalLink size={12} />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
