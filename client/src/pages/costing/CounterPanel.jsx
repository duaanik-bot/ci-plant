// The customer's counter-offer, and our revised quotation — one panel, the same on the desk's Counter tab, the enquiry
// card, single costing and bulk costing (owner, 11 Nov 2026: "one control … the customer target price and his quotation
// counter … one field in which we will be setting our final price. That will be the revised quotation for that party,
// for that mail thread … the loss in the whole order, in the whole batch; the total percentage of the discount asked").
// Internal: cost, loss and discount never leave CI Plant — the revised quotation is the approved template (product,
// details asked, rate) replying in the counter mail's thread.
import { useEffect, useMemo, useState } from 'react';
import { Calculator, Handshake, Lock, Mail, Send } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Input, useToast } from '../../components/ui.jsx';
import { qtyText, rupees, dateText } from '../../lib/enquiryUi.js';
import { counterLines, counterTotals, FILLS, keyOf } from '../../lib/counterMath.js';
import { quoteAndDraft, sendSummary } from '../../lib/quoteFlow.js';

const inr0 = v => (v == null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`);
const signed = v => (v == null ? '—' : `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const pct = v => (v == null ? '—' : `${v.toFixed(1)}%`);
const unit = v => (v == null ? '—' : `${v < 0 ? '−' : '+'}${rupees(Math.abs(v), 3)}`);
const tone = v => (v == null ? 'text-slate-500' : v < 0 ? 'text-red-700' : 'text-emerald-700');

function Tile({ label, value, sub, cls = '' }) {
  return (
    <div className="min-w-[8.5rem] rounded-xl bg-white/80 px-3 py-2 ring-1 ring-slate-200">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default function CounterPanel({ rows = [], canSend = false, onChanged, title = 'Customer counter → revised quotation' }) {
  const toast = useToast();
  const [boxes, setBoxes] = useState({});     // revised price typed
  const [theirsTyped, setTheirsTyped] = useState({}); // their price typed / corrected
  const [plus, setPlus] = useState('0.10');
  const [busy, setBusy] = useState(false);
  const stamp = rows.map(r => `${r.id}:${r.updated_at}`).join(',');
  useEffect(() => { setBoxes({}); setTheirsTyped({}); }, [stamp]);

  // Their typed price rides on the rows before the maths, so the totals move as it is typed.
  const live = useMemo(() => rows.map(e => ({
    ...e, prices: (e.prices || []).map(p => {
      const t = theirsTyped[keyOf(e.id, p.qty)];
      return t === undefined ? p : { ...p, theirs: t === '' ? null : Number(t) };
    }),
  })), [rows, theirsTyped]);
  const lines = useMemo(() => counterLines(live, boxes), [live, boxes]);
  const t = useMemo(() => counterTotals(lines), [lines]);
  if (!rows.length) return null;

  const countered = rows.filter(e => e.status === 'countered');
  const mail = rows.find(e => e.counter_subject) || null;
  const batch = [...new Set(rows.map(e => e.batch_id).filter(Boolean))];
  const fillAll = f => setBoxes(b => { const n = { ...b }; for (const l of lines) { const v = f(l); if (v != null) n[keyOf(l.id, l.qty)] = String(v); } return n; });
  const theirsDirty = Object.keys(theirsTyped).length > 0;

  const saveTheirs = async () => {
    if (!theirsDirty) return;
    const items = rows.map(e => ({ id: e.id, prices: (e.prices || []).filter(p => theirsTyped[keyOf(e.id, p.qty)] !== undefined)
      .map(p => ({ qty: p.qty, theirs: theirsTyped[keyOf(e.id, p.qty)] })) })).filter(it => it.prices.length);
    const r = await api.put('/costing/enquiries/counter', { items });
    if (r.skipped?.length) toast.error(r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; '));
  };
  const lockRevised = async () => {
    const items = countered.map(e => ({ id: e.id, prices: (e.prices || []).map(p => {
      const l = lines.find(x => x.id === e.id && x.qty === p.qty);
      return { qty: p.qty, final: l?.revised };
    }) }));
    const bad = items.flatMap(it => it.prices.filter(p => !(p.final > 0)).map(() => rows.find(e => e.id === it.id)?.enquiry_no));
    if (bad.length) { toast.error(`Every revised price must be above zero (${[...new Set(bad)].join(', ')}).`); return false; }
    await api.put('/costing/enquiries/prices', { items });
    return true;
  };
  const act = async fn => { setBusy(true); try { await fn(); onChanged?.(); } finally { setBusy(false); } };
  const doRecord = () => act(async () => { await saveTheirs(); toast.success('Customer counter saved'); });
  const doLock = () => act(async () => { await saveTheirs(); if (await lockRevised()) toast.success('Revised prices locked'); });
  const doSend = () => act(async () => {
    await saveTheirs();
    if (!(await lockRevised())) return;
    const r = await quoteAndDraft(api, countered.map(e => e.id));
    if (r.failed.length) toast.error(r.failed.join('; '));
    (r.drafted.length ? toast.success : toast.info)(sendSummary(r));
  });

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-3" aria-label={title}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Handshake size={16} className="text-amber-700" />
        <div className="text-sm font-bold text-[#1D1D1F]">{title}</div>
        {mail && (
          <span className="text-xs text-slate-600">
            <Mail size={12} className="mr-1 inline" />“{mail.counter_subject}” · {dateText(mail.counter_received_at || mail.counter_at)}
            {mail.counter_view_url && <> · <a href={mail.counter_view_url} target="_blank" rel="noreferrer" className="font-semibold text-brand-700 hover:underline">open the mail</a></>}
          </span>
        )}
        <span className="ml-auto text-[11px] text-slate-500">Internal — cost, loss and discount never go to the customer</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Tile label="Our quote" value={inr0(t.value_ours)} sub={`${t.items} line${t.items === 1 ? '' : 's'}`} />
        <Tile label="Their counter" value={inr0(t.value_theirs)} sub={`${t.countered} with their price`} />
        <Tile label="Discount asked" value={pct(t.disc_asked_pct)} sub={t.disc_asked_value != null ? `${inr0(t.disc_asked_value)} off our quote` : ''} cls="text-amber-800" />
        <Tile label="Our cost" value={inr0(t.cost)} sub={t.missing_cost ? `${t.missing_cost} without a costing` : 'before margin'} />
        <Tile label="At their price" value={signed(t.at_theirs)} sub={t.below_cost_theirs ? `${t.below_cost_theirs} line${t.below_cost_theirs === 1 ? '' : 's'} below cost` : 'no line below cost'} cls={tone(t.at_theirs)} />
        <Tile label="At our revised" value={signed(t.at_revised)} sub={`${inr0(t.value_revised)} · ${pct(t.disc_given_pct)} off`} cls={tone(t.at_revised)} />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-slate-600">Fill every revised price:</span>
        <button type="button" className="rounded-full bg-white px-2.5 py-1 font-semibold ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => fillAll(FILLS.theirs)}>Their price</button>
        <button type="button" className="rounded-full bg-white px-2.5 py-1 font-semibold ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => fillAll(FILLS.halfway)}>Halfway</button>
        <span className="inline-flex items-center gap-1">
          <button type="button" className="rounded-full bg-white px-2.5 py-1 font-semibold ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => fillAll(l => FILLS.costPlus(l, plus))}>Cost +</button>
          <Input className="!h-7 !w-16 text-right text-xs" inputMode="decimal" value={plus} onChange={e => setPlus(e.target.value)} aria-label="Rupees over cost" />
        </span>
        <button type="button" className="rounded-full bg-white px-2.5 py-1 font-semibold ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => fillAll(FILLS.ours)}>Our quote</button>
        {batch.length === 1 && (
          <a href={`/costing?tab=bulk&batch=${batch[0]}`} className="ml-auto inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline">
            <Calculator size={12} />Re-cost the batch
          </a>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl bg-white/70 ring-1 ring-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-2 py-1.5">Item</th><th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Our quote</th><th className="px-2 py-1.5 text-right">Their price</th>
              <th className="px-2 py-1.5 text-right">Our cost</th><th className="px-2 py-1.5 text-right">Asked</th>
              <th className="px-2 py-1.5 text-right">At their price</th>
              <th className="px-2 py-1.5 text-right">Revised ₹</th><th className="px-2 py-1.5 text-right">At revised</th>
              <th className="px-2 py-1.5 text-right">Given</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => {
              const k = keyOf(l.id, l.qty);
              const row = rows.find(e => e.id === l.id);
              const editable = row?.status === 'countered';
              return (
                <tr key={k} className={`border-t border-slate-100 ${l.theirs_below_cost ? 'bg-red-50/40' : ''}`}>
                  <td className="px-2 py-1"><div className="font-semibold">{l.product}</div><div className="text-[10px] text-slate-500">{l.enquiry_no}</div></td>
                  <td className="px-2 py-1 text-right tabular-nums">{qtyText(l.qty)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{l.ours != null ? rupees(l.ours, 2) : '—'}</td>
                  <td className="px-2 py-1 text-right">
                    <Input className="!h-7 !w-20 text-right text-xs" inputMode="decimal" disabled={!editable}
                      value={theirsTyped[k] ?? (l.theirs != null ? String(l.theirs) : '')} placeholder="—"
                      onChange={e => setTheirsTyped(s => ({ ...s, [k]: e.target.value }))} aria-label={`Their price, ${l.product}`} />
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-600">{l.cost != null ? rupees(l.cost, 3) : '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{l.disc_asked != null ? pct(l.disc_asked * 100) : '—'}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${tone(l.at_theirs)}`}>{unit(l.at_theirs_unit)}<div className="text-[10px]">{signed(l.at_theirs)}</div></td>
                  <td className="px-2 py-1 text-right">
                    <Input className={`!h-7 !w-20 text-right text-xs font-bold ${l.revised_below_cost ? '!text-red-700' : ''}`} inputMode="decimal" disabled={!editable}
                      value={boxes[k] ?? (l.revised != null ? String(l.revised) : '')}
                      onChange={e => setBoxes(b => ({ ...b, [k]: e.target.value }))} aria-label={`Revised price, ${l.product}`} />
                  </td>
                  <td className={`px-2 py-1 text-right tabular-nums ${tone(l.at_revised)}`}>{unit(l.at_revised_unit)}<div className="text-[10px]">{signed(l.at_revised)}</div></td>
                  <td className="px-2 py-1 text-right tabular-nums">{l.disc_given != null ? pct(l.disc_given * 100) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {theirsDirty && <Button size="sm" variant="secondary" onClick={doRecord} disabled={busy}>Save their prices</Button>}
        {countered.length > 0 && <Button size="sm" variant="secondary" onClick={doLock} disabled={busy}><Lock size={13} className="mr-1 inline" />Lock revised prices</Button>}
        {countered.length > 0 && canSend && (
          <Button size="sm" variant="success" onClick={doSend} disabled={busy}
            title="Locks the revised prices, makes the revised quotation and saves the reply as a Gmail draft in the customer's thread">
            <Send size={13} className="mr-1 inline" />Send revised quotation
          </Button>
        )}
        {countered.length > 0 && !canSend && <span className="text-xs text-slate-500">Sending needs the Management right.</span>}
        {!countered.length && <span className="text-xs text-slate-500">The revised quotation for these has been made.</span>}
      </div>
    </section>
  );
}
