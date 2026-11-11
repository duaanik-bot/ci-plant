// Send the quotation from wherever the enquiry is open (owner, 11 Nov 2026: "make this 'Send the Quotation' button very
// seamless … controls at every level — the list, the form, the costing, the single costing"). One panel, the same
// everywhere: the final price box (pre-filled from the costing, editable), Lock, Send quotation, and where it stands.
// Send = ONE server step (POST /costing/quotations/send): lock → finalise → quotation (approved template) → Gmail reply
// draft in the customer's thread. Never sends mail: a person checks the draft and sends it from Gmail.
import { useEffect, useState } from 'react';
import { ExternalLink, Lock, LockOpen, Mail, Send } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Input, useToast } from '../../components/ui.jsx';
import { qtyText, rupees } from '../../lib/enquiryUi.js';
import { quoteAndDraft, sendSummary } from '../../lib/quoteFlow.js';
import CounterPanel from './CounterPanel.jsx';

const WHERE = {
  queued: 'With Claude — the reply draft is made on the robot\'s next run',
  drafted: 'Reply draft is in Gmail — check it and press Send there',
  sent: 'Sent to the customer',
  ready: 'Quotation made — no draft yet',
};

export default function SendQuotePanel({ enquiryId, canSend = false, reloadSignal = 0, onChanged, title = 'Final price & send the quotation' }) {
  const toast = useToast();
  const [e, setE] = useState(null);
  const [boxes, setBoxes] = useState({});       // qty → typed text
  const [open, setOpen] = useState(false);      // a locked price opened again
  const [busy, setBusy] = useState(false);
  const load = () => (enquiryId ? api.get(`/costing/enquiries/${enquiryId}`).then(x => { setE(x); setBoxes({}); setOpen(false); }).catch(() => {}) : Promise.resolve());
  useEffect(() => { load(); }, [enquiryId, reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) return null;
  // The customer answered with their own prices: the counter panel takes over (their price, our cost, the revised price).
  if (e.status === 'countered') return <CounterPanel rows={[e]} canSend={canSend} onChanged={() => { load(); onChanged?.(); }} />;

  const prices = e.prices || [];
  const boxOf = p => boxes[p.qty] ?? (p.final != null ? String(p.final) : p.suggested != null ? String(p.suggested) : '');
  const onQuote = !!e.quotation_no && e.quotation_status !== 'cancelled';
  const locked = prices.length > 0 && !open && prices.every(p => p.final != null && !p.changed && String(p.final) === String(boxOf(p)));
  const lockNow = async () => {
    const items = [{ id: e.id, prices: prices.map(p => ({ qty: p.qty, final: Number(boxOf(p)) })) }];
    if (items[0].prices.some(p => !(p.final > 0))) { toast.error('Every quantity needs a final price above zero.'); return false; }
    await api.put('/costing/enquiries/prices', { items });
    return true;
  };
  const act = async fn => { setBusy(true); try { await fn(); await load(); onChanged?.(); } finally { setBusy(false); } };
  const doLock = () => act(async () => { if (await lockNow()) toast.success(`${e.enquiry_no}: price locked`); });
  const doSend = () => act(async () => {
    if (!locked && !(await lockNow())) return;
    const r = await quoteAndDraft(api, [e.id]);
    if (r.failed.length) toast.error(r.failed.join('; '));
    (r.drafted.length ? toast.success : toast.info)(sendSummary(r));
  });

  if (!prices.length) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white/70 p-3 text-xs text-slate-500">
        <div className="mb-0.5 text-sm font-bold text-[#1D1D1F]">{title}</div>
        Save a complete costing for {e.enquiry_no} first — then its price shows here, ready to lock and send.
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3" aria-label={title}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-sm font-bold text-[#1D1D1F]">{title}</div>
        <span className="text-xs text-slate-500">{e.enquiry_no} · the customer sees only the product, the details they asked and this rate</span>
      </div>
      <div className="space-y-1">
        {prices.map(p => (
          <div key={p.qty} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 text-right font-semibold tabular-nums">{qtyText(p.qty)}</span>
            <span className="w-28 text-right text-xs text-slate-500" title="Worked out by the costing — the box starts at it">costing {rupees(p.proposed, 3)}</span>
            <Input className={`!h-9 !w-28 text-right ${locked ? '!bg-emerald-50 font-bold text-emerald-900' : ''}`} inputMode="decimal"
              readOnly={locked || onQuote} value={boxOf(p)} onChange={ev => setBoxes(b => ({ ...b, [p.qty]: ev.target.value }))} />
            <span className="text-xs text-slate-500">₹ a carton</span>
            {p.changed && <span className="text-xs font-semibold text-amber-700">costing changed since it was locked</span>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!onQuote && (locked
          ? <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-200"><Lock size={12} />Locked · Unlock</button>
          : <Button size="sm" variant="secondary" onClick={doLock} disabled={busy}><LockOpen size={13} className="mr-1 inline" />Lock price</Button>)}
        {!onQuote && canSend && (
          <Button size="sm" variant="success" onClick={doSend} disabled={busy} title="Locks the price, makes the quotation and saves the reply as a Gmail draft in the customer's thread">
            <Send size={13} className="mr-1 inline" />{locked ? 'Send quotation' : 'Lock & send quotation'}
          </Button>
        )}
        {!onQuote && !canSend && <span className="text-xs text-slate-500">Sending needs the Management right.</span>}
        {onQuote && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
            <Mail size={12} />{e.quotation_no} · {WHERE[e.quotation_status] || e.quotation_status}
          </span>
        )}
        {onQuote && e.quotation_draft_url && (
          <a href={e.quotation_draft_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-brand-700 hover:underline">Open the draft in Gmail <ExternalLink size={12} /></a>
        )}
      </div>
    </section>
  );
}
