// Order finalised (owner, 12 Nov 2026: "Once the order is finalised with the customer, we need a button to finalise the
// order … the price at which the order is being finalised should be pre-filled but still editable … it needs to be
// mentioned what the loss is where we have booked this order … [the mail] will directly shoot to mppchd@gmail.com …
// in the form of a table"). Spec: docs/superpowers/specs/2026-11-13-order-finalised-design.md
//
//   OrderPanel  the items the customer ordered: quantity and rate (pre-filled, editable), our cost a carton, the margin
//               or loss, output sheet, ups, board, art, New die and KLD. Finalise order (Management) keeps the order and
//               sends the order sheet to the company mailbox — rates only; cost and loss stay in CI Plant.
//   OrdersList  the desk's Orders tab: every finalised order, its value, the loss booked, and its order sheet (Send again).
import { useEffect, useState } from 'react';
import { Mail, PackageCheck, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { confirmSaid, draftOrderConfirmation } from '../../lib/orderConfirm.js';
import { Button, Checkbox, DataTable, Input, Modal, useToast } from '../../components/ui.jsx';
import { dateText, qtyText, rupees } from '../../lib/enquiryUi.js';
import { shownLine, shownTotals } from '../../lib/orderUi.js';

const tone = v => (v == null ? 'text-slate-500' : v < 0 ? 'text-red-700' : 'text-emerald-700');
const pctSigned = v => (v == null ? '' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`);
const signed = (v, dp = 2) => (v == null ? '—' : `${v < 0 ? '−' : '+'}${rupees(Math.abs(v), dp)}`);
const sheetText = l => (l.sheet ? `${l.sheet.l} × ${l.sheet.w} in` : '—');
const boardText = l => [l.board, l.gsm ? `${l.gsm} GSM` : null].filter(Boolean).join(', ') || '—';

function Tile({ label, value, sub, cls = '' }) {
  return (
    <div className="min-w-[9rem] rounded-xl bg-white/80 px-3 py-2 ring-1 ring-slate-200">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default function OrderPanel({ ids, onClose, onDone }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  // Asked on Finalise (owner, 21 Nov 2026: "whenever we finalise the order, you ask me to send the mail … to mppchd … attach
  // the KLDs and the output sizes … and the final rates"), not a box ticked beforehand.
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = Array.isArray(ids) && ids.length > 0;
  const key = open ? ids.join(',') : '';
  useEffect(() => {
    setData(null); setEdits({});
    if (!open) return undefined;
    let live = true;
    api.post('/costing/enquiries/order-preview', { ids })
      .then(d => { if (!live) return; setData(d); })
      .catch(() => { if (live) onClose?.(); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (id, k, v) => setEdits(cur => ({ ...cur, [id]: { ...cur[id], [k]: v } }));
  // A new quantity is costed again on the server: the cost a carton moves with the quantity.
  const recost = async (id) => {
    const qty = edits[id]?.qty;
    if (qty === undefined) return;
    try {
      const d = await api.post('/costing/enquiries/order-preview', { ids: [id], items: [{ id, qty }] });
      const l = d.lines?.[0];
      if (l && !l.error) setData(cur => ({ ...cur, lines: cur.lines.map(x => (x.enquiry_id === id ? { ...x, cost: l.cost } : x)) }));
    } catch { /* the error is already shown */ }
  };

  const lines = (data?.lines || []).map(l => shownLine(l, edits[l.enquiry_id]));
  const t = shownTotals(lines);
  const bad = lines.find(l => l.bad);
  const customers = [...new Set(lines.map(l => l.customer_name).filter(Boolean))];

  const finalise = async mail => {
    setAsking(false);
    setBusy(true);
    try {
      const r = await api.post('/costing/enquiries/order', {
        items: lines.map(l => ({ id: l.enquiry_id, qty: l.qty, rate: l.rate, new_die: l.new_die, so_auto: !!edits[l.enquiry_id]?.so_auto })), mail,
      });
      const tail = r.mail?.status === 'sent' ? ` — the order sheet went to ${r.mail.to}`
        : r.mail?.status === 'failed' ? ` — the order sheet was NOT sent (${r.mail.error}). Send again from the Orders tab.` : '';
      (r.mail?.status === 'failed' ? toast.error : toast.success)(`${r.order.order_no} finalised for ${r.order.customer_name || 'the customer'}${tail}`);
      if (r.refused?.length) toast.info(`Not on the order: ${r.refused.map(x => `${x.enquiry_no} ${x.why}`).join('; ')}`);
      onDone?.(r);
    } catch { /* the error is already shown */ } finally { setBusy(false); }
  };

  const footer = data && (
    <div className="flex w-full flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1 text-xs">
        {asking ? (
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-950 ring-1 ring-emerald-200">
            <b>Send the order sheet to {data.company} now?</b> Every item with its final rate and quantity, the output sheet and ups, the board,
            the die (new or existing) and the art details — each drawn KLD attached as a PDF. Rates only: cost and loss stay here.
            {t.newDies > 0 && <div className="mt-1 font-semibold text-amber-800">A new die is on this order — the team usually needs the sheet.</div>}
          </div>
        ) : data.can_send ? (
          <span className="text-slate-500">On Finalise you are asked whether the order sheet goes to <b>{data.company}</b>.</span>
        ) : (
          <span className="text-amber-800">The order sheet cannot go by mail yet: {data.company ? `the mailbox in use (${data.sender || '—'}) has no Gmail connected` : 'no business mailbox address is set'}. The order is still kept.</span>
        )}
      </div>
      {asking ? <>
        <Button variant="secondary" onClick={() => setAsking(false)}>Back</Button>
        <Button variant="secondary" disabled={busy} onClick={() => finalise(false)}>Finalise only — no mail</Button>
        <Button variant="success" disabled={busy} onClick={() => finalise(true)}><Mail size={14} className="mr-1.5 inline" />Yes — finalise and send</Button>
      </> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="success" disabled={busy || !lines.length || !!bad || !data.can_finalise}
          onClick={() => (data.can_send ? setAsking(true) : finalise(false))}
          title={!data.can_finalise ? 'Finalising an order needs the Management right' : bad ? `A line needs a ${bad.bad}` : ''}>
          <PackageCheck size={15} className="mr-1.5 inline" />{busy ? 'Finalising…' : 'Finalise order'}
        </Button>
      </>}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} size="xl" footer={footer}
      title={customers.length ? `Order finalised — ${customers.join(' · ')}` : 'Order finalised'}>
      {!data ? <div className="p-6 text-sm text-slate-400">Loading the order…</div> : (
        <div className="space-y-3">
          <p className="text-xs text-slate-500"><b>At what rate was the order finalised?</b> Each line starts at our final given rate — change any that differ from what was agreed.
            When the customer's sales order comes in, <b>Orders</b> checks its rates against these and can take the actual ones in; the order stays finalised.
            Our cost a carton comes from the costing (a new quantity is costed again). A rate under our cost is booked as a loss on the order.</p>
          <div className="flex flex-wrap gap-2">
            <Tile label="Order value" value={rupees(t.total, 0)} sub={`${lines.length} item${lines.length === 1 ? '' : 's'}`} />
            <Tile label={t.net < 0 ? 'Loss on the order' : 'Profit on the order'} value={`${signed(t.net, 0)} ${pctSigned(t.net_pct)}`} cls={tone(t.net)}
              sub="at the rates agreed, against our cost" />
            <Tile label="Loss booked" value={t.loss > 0 ? rupees(t.loss, 0) : 'None'} cls={t.loss > 0 ? 'text-red-700' : 'text-emerald-700'}
              sub={t.atLoss ? `${t.atLoss} item${t.atLoss === 1 ? '' : 's'} below our cost` : 'every rate is above our cost'} />
            <Tile label="New dies" value={t.newDies || 'None'} sub={t.newDies ? 'the team makes these' : 'existing dies'} />
          </div>
          {data.refused?.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              Not on this order: {data.refused.map(x => `${x.enquiry_no} ${x.why}`).join('; ')}.
            </div>
          )}
          <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
            <table className="w-full min-w-[1100px] text-xs">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>{['Item', 'Quantity', 'Rate a carton', 'Our cost', 'Margin a carton', 'On the order', 'Output sheet · ups', 'Board', 'Art details', 'New die', 'KLD']
                  .map(h => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.enquiry_id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-2">
                      <div className="font-semibold text-[#1D1D1F]">{l.product}</div>
                      <div className="text-[11px] text-slate-500">{[l.enquiry_no, l.size && `${l.size} mm`, l.style, l.quotation_no].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-2 py-2">
                      <Input className={`!h-8 w-24 text-right ${l.bad === 'quantity' ? 'ring-2 ring-red-300' : ''}`} inputMode="numeric"
                        value={edits[l.enquiry_id]?.qty ?? String(l.qty ?? '')} onChange={e => edit(l.enquiry_id, 'qty', e.target.value)} onBlur={() => recost(l.enquiry_id)} />
                    </td>
                    <td className="px-2 py-2">
                      <Input className={`!h-8 w-24 text-right ${l.bad === 'rate' ? 'ring-2 ring-red-300' : ''}`} inputMode="decimal"
                        value={edits[l.enquiry_id]?.rate ?? String(l.rate ?? '')} onChange={e => edit(l.enquiry_id, 'rate', e.target.value)} />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {l.final != null && l.final !== l.quoted && <button type="button" className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700 hover:bg-brand-100" onClick={() => edit(l.enquiry_id, 'rate', String(l.final))}>Our final {rupees(l.final)}</button>}
                        {l.quoted != null && <button type="button" className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700 hover:bg-slate-200" onClick={() => edit(l.enquiry_id, 'rate', String(l.quoted))}>Quoted {rupees(l.quoted)}</button>}
                        <label className="mt-0.5 flex w-full cursor-pointer items-center gap-1 text-[10px] font-semibold text-sky-800" title="Finalised at the rate above; once the customer's sales order is in, its rate and quantity are taken onto this line by themselves">
                          <input type="checkbox" className="h-3 w-3 accent-sky-600" checked={!!edits[l.enquiry_id]?.so_auto} onChange={e => edit(l.enquiry_id, 'so_auto', e.target.checked)} />
                          Take from the sales order when it comes
                        </label>
                        {l.counter != null && <button type="button" className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900 hover:bg-amber-200" onClick={() => edit(l.enquiry_id, 'rate', String(l.counter))}>Their {rupees(l.counter)}</button>}
                      </div>
                    </td>
                    <td className="px-2 py-2 tabular-nums text-slate-700">{rupees(l.cost, 3)}</td>
                    <td className={`px-2 py-2 font-semibold tabular-nums ${tone(l.margin)}`}>{signed(l.margin, 3)}<div className="text-[10px]">{pctSigned(l.margin_pct)} on cost</div></td>
                    <td className={`px-2 py-2 font-bold tabular-nums ${tone(l.margin_total)}`}>{signed(l.margin_total, 0)}
                      <div className="text-[10px] font-normal text-slate-500">value {rupees(l.value, 0)}</div></td>
                    <td className="px-2 py-2 whitespace-nowrap">{sheetText(l)}<div className="text-[11px] text-slate-500">{l.ups ? `${l.ups} ups` : 'ups —'}</div></td>
                    <td className="px-2 py-2">{boardText(l)}</td>
                    <td className="max-w-[220px] px-2 py-2 text-slate-600">{l.art || '—'}</td>
                    <td className="px-2 py-2"><Checkbox checked={!!l.new_die} onChange={e => edit(l.enquiry_id, 'new_die', e.target.checked)} label={l.new_die ? <b className="text-red-700">New die</b> : 'Existing'} /></td>
                    <td className="px-2 py-2 text-[11px]">{l.kld ? <span className="font-semibold text-emerald-700">rev {l.kld.rev} — goes with the mail</span> : <span className="text-slate-500">not drawn</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!lines.length && <div className="text-sm text-slate-500">None of these can go on an order.</div>}
        </div>
      )}
    </Modal>
  );
}

// One finalised order, line by line, with what each line makes or loses.
function OrderView({ order, onClose }) {
  return (
    <Modal open={!!order} onClose={onClose} size="xl" title={order ? `${order.order_no} — ${order.customer_name || ''}` : ''}>
      {order && (
        <div className="space-y-3 text-xs">
          <div className="text-slate-500">Finalised {dateText(order.created_at)} by {order.created_by_name}{order.quotation_no ? ` · quotation ${order.quotation_no}` : ''}
            {' · '}order sheet: {order.mail_status === 'sent' ? `sent to ${order.mail_to} ${dateText(order.mail_sent_at)}` : order.mail_status === 'failed' ? `not sent — ${order.mail_error}` : 'not sent'}</div>
          <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
            <table className="w-full min-w-[900px]">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>{['Item', 'Quantity', 'Rate', 'Sales order', 'Our cost', 'On the order', 'Output sheet · ups', 'Board', 'Die', 'KLD'].map(h => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {order.lines.map(l => (
                  <tr key={l.enquiry_id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-2"><div className="font-semibold">{l.product}</div><div className="text-[11px] text-slate-500">{[l.enquiry_no, l.size && `${l.size} mm`].filter(Boolean).join(' · ')}</div></td>
                    <td className="px-2 py-2 tabular-nums">{qtyText(l.qty)}</td>
                    <td className="px-2 py-2 tabular-nums">{rupees(l.rate)}</td>
                    <td className="px-2 py-2 tabular-nums">{l.actual_rate != null ? <><b>{qtyText(l.actual_qty)} @ {rupees(l.actual_rate)}</b><div className="text-[10px] text-slate-500">PO {l.actual_po}</div></> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-2 py-2 tabular-nums text-slate-600">{rupees(l.cost, 3)}</td>
                    <td className={`px-2 py-2 font-bold tabular-nums ${tone(l.margin_total)}`}>{signed(l.margin_total, 0)}
                      <div className="text-[10px] font-normal">{l.cost ? pctSigned(((l.rate - l.cost) / l.cost) * 100) : ''}</div></td>
                    <td className="px-2 py-2 whitespace-nowrap">{sheetText(l)} · {l.ups ? `${l.ups} ups` : '—'}</td>
                    <td className="px-2 py-2">{boardText(l)}</td>
                    <td className="px-2 py-2">{l.new_die ? <b className="text-red-700">New die</b> : 'Existing'}</td>
                    <td className="px-2 py-2">{l.kld ? `rev ${l.kld.rev}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

const MAIL_TONE = { sent: 'bg-emerald-100 text-emerald-800', failed: 'bg-red-100 text-red-800', none: 'bg-slate-100 text-slate-600' };
const MAIL_LABEL = { sent: 'Sent to the team', failed: 'Not sent', none: 'Not sent' };

export function OrdersList({ canSend, signal }) {
  const toast = useToast();
  const [orders, setOrders] = useState(null);
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => api.get('/costing/enquiry-orders').then(setOrders).catch(() => setOrders([]));
  useEffect(() => { load(); }, [signal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [checking, setChecking] = useState(null);   // the sales-order check open for an order
  // The order confirmation to the customer, as a Gmail draft in their thread (21 Nov 2026).
  const confirm = async (o) => {
    setBusy(`c${o.id}`);
    try {
      const r = await draftOrderConfirmation(api, o);
      if (r) { toast.success(confirmSaid(r, o.order_no)); await load(); }
    } catch { /* the error is already shown */ } finally { setBusy(null); }
  };
  const again = async (o) => {
    setBusy(o.id);
    try {
      const r = await api.post(`/costing/enquiry-orders/${o.id}/mail`);
      (r.mail?.status === 'sent' ? toast.success : toast.error)(r.mail?.status === 'sent' ? `${o.order_no}: the order sheet went to ${r.mail.to}` : `${o.order_no}: not sent — ${r.mail?.error}`);
      await load();
    } catch { /* the error is already shown */ } finally { setBusy(null); }
  };
  const cols = [
    { key: 'order_no', label: 'Order', render: o => <span className="font-bold text-brand-600">{o.order_no}</span> },
    { key: 'customer_name', label: 'Customer', render: o => <div><div className="font-semibold">{o.customer_name || '—'}</div><div className="text-[11px] text-slate-500">{o.quotation_no || ''}</div></div> },
    { key: 'items', label: 'Items', render: o => o.lines.length },
    { key: 'total', label: 'Value', align: 'right', render: o => rupees(o.total, 0) },
    { key: 'loss', label: 'Loss booked', align: 'right', render: o => (o.loss > 0
      ? <span className="font-bold text-red-700">{rupees(o.loss, 0)}<span className="block text-[10px] font-normal">{o.items_at_loss} item{o.items_at_loss === 1 ? '' : 's'} below cost</span></span>
      : <span className="text-emerald-700">None</span>) },
    { key: 'new_dies', label: 'New dies', render: o => o.new_dies || '—' },
    { key: 'mail_status', label: 'Order sheet', render: o => (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${MAIL_TONE[o.mail_status]}`} title={o.mail_error || o.mail_to || ''}><Mail size={11} className="mr-1 inline" />{MAIL_LABEL[o.mail_status]}</span>
        {canSend && o.mail_status !== 'sent' && (
          <button type="button" disabled={busy === o.id} onClick={ev => { ev.stopPropagation(); again(o); }}
            className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100 disabled:opacity-50">
            <RotateCcw size={11} />{busy === o.id ? 'Sending…' : o.mail_status === 'failed' ? 'Send again' : 'Send'}</button>
        )}
      </div>
    ) },
    { key: 'so', label: 'Sales order', render: o => (
      <button type="button" onClick={ev => { ev.stopPropagation(); setChecking(o); }}
        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${o.so_checked_at ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
          : o.so?.found ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-slate-50 text-slate-500 ring-slate-200'}`}
        title={o.so_checked_at ? `Actual rates taken ${dateText(o.so_checked_at)} by ${o.so_checked_by || ''}` : 'Check the rates against the sales order'}>
        {o.so_checked_at ? `Actual rates in${o.so?.pos?.length ? ` · PO ${o.so.pos.join(', ')}` : ''}`
          : o.so?.found ? `PO ${o.so.pos.join(', ')} found · ${o.so.found}/${o.so.of}${o.so.differ ? ` · ${o.so.differ} differ` : ''} — check`
            : o.so?.waiting ? `Waiting for the sales order · ${o.so.waiting} line${o.so.waiting === 1 ? '' : 's'}` : 'Not in yet · check'}
      </button>
    ) },
    { key: 'customer_draft', label: 'To the customer', render: o => (
      <div className="flex flex-wrap items-center gap-1.5">
        {o.customer_draft_id
          ? <a href={o.customer_draft_url || 'https://mail.google.com/mail/#drafts'} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()}
            className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800 hover:underline" title={`Saved ${dateText(o.customer_drafted_at)}`}>
            <Mail size={11} className="mr-1 inline" />Draft in Gmail</a>
          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">No confirmation yet</span>}
        {canSend && (
          <button type="button" disabled={busy === `c${o.id}`} onClick={ev => { ev.stopPropagation(); confirm(o); }}
            className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100 disabled:opacity-50">
            {busy === `c${o.id}` ? 'Saving…' : o.customer_draft_id ? 'Update the draft' : 'Draft confirmation'}</button>
        )}
      </div>
    ) },
    { key: 'when', label: 'Finalised', sortValue: o => o.created_at, render: o => `${dateText(o.created_at)} · ${o.created_by_name || ''}` },
  ];
  return (
    <div className="mb-6">
      <div className="mb-2 text-sm font-bold text-[#1D1D1F]">Finalised orders</div>
      <DataTable rows={orders || []} columns={cols} onRowClick={setView} defaultSort={{ key: 'when', dir: 'desc' }} serialNumber={false}
        empty={orders ? 'No order finalised yet — press Order finalised on a quoted row.' : 'Loading…'} />
      <OrderView order={view} onClose={() => setView(null)} />
      <SalesOrderCheck order={checking} canApply={canSend} onClose={() => setChecking(null)} onApplied={() => { setChecking(null); load(); }} />
    </div>
  );
}

// The sales order against a finalised order (owner, 21 Nov 2026): line by line, what was finalised beside what the customer's
// sales order says — and, on Take, the actual rate and quantity kept on the order beside the finalised ones. The order stays
// finalised; its profit is shown at the actual rate too.
function SalesOrderCheck({ order, canApply, onClose, onApplied }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());   // line indexes to take now
  useEffect(() => {
    setData(null);
    if (!order) return;
    api.post(`/costing/enquiry-orders/${order.id}/sales-order`, {}).then(d => {
      setData(d);
      // ticked to start: the found lines not taken yet
      setTicked(new Set(d.matched.map((m, i) => (m.so && d.order.lines[i]?.actual_rate == null ? i : null)).filter(i => i != null)));
    }).catch(() => onClose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);
  // Take now — the ticked rows, or the whole batch (owner, 21 Nov 2026: "for the whole batch … even at the row level").
  const apply = async pick => {
    setBusy(true);
    try {
      const r = await api.post(`/costing/enquiry-orders/${order.id}/sales-order`, { apply: true, ...(pick ? { lines: [...pick] } : {}) });
      toast.success(`${order.order_no}: actual rates taken on ${r.taken} line${r.taken === 1 ? '' : 's'} from PO ${r.summary.pos.join(', ')} — the order stays finalised`);
      onApplied?.();
    } catch { /* shown */ } finally { setBusy(false); }
  };
  // "Take from the sales order when it comes", per row — saved at once.
  const setAuto = async (i, on) => {
    try {
      const r = await api.post(`/costing/enquiry-orders/${order.id}/sales-order`, { auto: { [i]: on } });
      setData(r);
    } catch { /* shown */ }
  };
  const lines = data?.matched || [];
  const costOf = m => (order?.lines || []).find(l => (l.enquiry_id ?? null) === (m.enquiry_id ?? null) && l.product === m.product)?.cost;
  const diff = (v, dp = 2) => (v == null ? '' : v === 0 ? 'same' : `${v < 0 ? '−' : '+'}${dp ? rupees(Math.abs(v), dp) : Math.abs(v).toLocaleString('en-IN')}`);
  return (
    <Modal open={!!order} onClose={onClose} size="xl" title={order ? `${order.order_no} — rates against the sales order` : ''}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {canApply && data?.summary?.found > 0 && <Button variant="secondary" disabled={busy || !ticked.size} onClick={() => apply(ticked)}>Take the ticked rows ({ticked.size})</Button>}
        {canApply && data?.summary?.found > 0 && <Button variant="success" disabled={busy} onClick={() => apply(null)}>{busy ? 'Taking…' : 'Take the whole batch — stays finalised'}</Button>}
      </>}>
      {!data ? <div className="p-6 text-sm text-slate-400">Looking for the sales order…</div> : (
        <div className="space-y-3 text-xs">
          <p className="text-slate-600">{data.summary.found
            ? <>Found in <b>PO {data.summary.pos.join(', ')}</b>: {data.summary.found} of {data.summary.of} lines{data.summary.differ ? <>, <b className="text-amber-800">{data.summary.differ} differ</b></> : ', every rate and quantity the same'}.</>
            : <>No sales order for these products yet — it is looked for among {order.customer_name}'s sales orders entered from two weeks before this order on, matched by product name.</>}
            {order.so_checked_at && <> Actual rates were taken {dateText(order.so_checked_at)} by {order.so_checked_by}.</>}</p>
          <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
            <table className="w-full min-w-[820px]">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>{['Take', 'Item', 'Finalised', 'Sales order', 'Rate difference', 'Qty difference', 'Profit at the actual rate', 'When it comes'].map(h => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {lines.map((m, i) => {
                  const cost = costOf(m);
                  const at = m.so && cost != null ? (m.so.rate - cost) * m.so.qty : null;
                  return (
                    <tr key={`${m.enquiry_id}|${i}`} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-2">{m.so && <input type="checkbox" className="h-4 w-4 accent-emerald-600" disabled={!canApply} checked={ticked.has(i)}
                        onChange={e => setTicked(t => { const n = new Set(t); if (e.target.checked) n.add(i); else n.delete(i); return n; })} aria-label={`Take line ${i + 1}`} />}</td>
                      <td className="px-2 py-2"><div className="font-semibold">{m.product}</div><div className="text-[11px] text-slate-500">{m.enquiry_no}
                        {data.order.lines[i]?.actual_rate != null && <span className="ml-1 font-bold text-emerald-700">· taken @ {rupees(data.order.lines[i].actual_rate)}</span>}</div></td>
                      <td className="px-2 py-2 tabular-nums">{qtyText(m.qty)} @ <b>{rupees(m.rate)}</b></td>
                      <td className="px-2 py-2 tabular-nums">{m.so ? <>{qtyText(m.so.qty)} @ <b>{rupees(m.so.rate)}</b><div className="text-[11px] text-slate-500">PO {m.so.po_number} · {m.so.po_date} · {m.so.customer}</div></> : <span className="text-slate-400">not in yet</span>}</td>
                      <td className={`px-2 py-2 font-bold tabular-nums ${m.rate_diff ? (m.rate_diff < 0 ? 'text-red-700' : 'text-emerald-700') : 'text-slate-500'}`}>{diff(m.rate_diff)}</td>
                      <td className={`px-2 py-2 tabular-nums ${m.qty_diff ? 'font-bold text-amber-800' : 'text-slate-500'}`}>{diff(m.qty_diff, 0)}</td>
                      <td className={`px-2 py-2 font-bold tabular-nums ${tone(at)}`}>{at == null ? '—' : signed(at, 0)}</td>
                      <td className="px-2 py-2">
                        <label className="flex cursor-pointer items-center gap-1 text-[11px] font-semibold text-sky-800" title="Take this line's rate from the sales order by itself once it is in">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-sky-600" disabled={!canApply} checked={!!data.order.lines[i]?.rate_from_so} onChange={e => setAuto(i, e.target.checked)} />
                          Take from the sales order
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
